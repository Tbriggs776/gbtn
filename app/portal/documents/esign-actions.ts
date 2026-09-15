"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { assertStaff, getSession, sessionCan } from "@/lib/auth";
import { staffMessage } from "@/lib/esign/errors";
import { ESIGN_DOC_TYPES, type PreparedSource, type SendEnvelopeInput } from "@/lib/esign/types";
import {
  abandonSealing,
  createEnvelope,
  finishSealing,
  getMemberSealedCopyUrl,
  prepareEnvelopeSource,
  resendToRecipient,
  voidEnvelope,
  type AbandonSealResult,
  type CloseResult,
  type CreateEnvelopeResult,
  type FinishSealingResult,
} from "@/lib/esign/engine";

// Staff e-sign actions for the Documents page. Every export wraps EVERYTHING —
// including assertStaff()/getSession() — in one try, so a non-staff caller gets
// { error } instead of a thrown action (there is no error.tsx).
// unstable_rethrow lets a signed-out redirect from requireSession propagate.
// Messages come from staffMessage, which never returns a raw DB error.
//
// The sessionCan check here is on the client id the caller named; the engine
// re-checks it against the document's (or envelope's) real client_id before it
// touches the service role for anything tenant-scoped.

export type EsignActionState = { ok?: boolean; error?: string; message?: string };
export type PrepareState = EsignActionState & { source?: PreparedSource };
export type SendEnvelopeState = EsignActionState & { envelopeId?: string; links?: CreateEnvelopeResult["links"] };
export type ResendRecipientState = EsignActionState & { link?: { name: string; url: string; emailed: boolean } };

const FORM_ERROR = "Check the form and try again.";
const NO_CLIENT_ACCESS = "You don't have access to this client.";
const NOT_WAITING_TO_SEAL = "This envelope isn't waiting to be sealed.";
const SEALING_NOW = "Sealing is running right now. Try again in a few minutes.";

const Uuid = z.string().uuid();
const Order = z.number().int().min(1).max(10);
const Ppm = z.number().int().min(0).max(1_000_000);
const RecipientKey = z.string().regex(/^r\d{1,2}$/);

const recipientSchema = z.discriminatedUnion("kind", [
  z.object({ key: RecipientKey, kind: z.literal("client_contact"), order: Order, contactId: Uuid }),
  z.object({
    key: RecipientKey,
    kind: z.literal("outside"),
    order: Order,
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().max(32).optional(),
  }),
  z.object({ key: RecipientKey, kind: z.literal("staff"), order: Order, staffUserId: Uuid }),
]);

const fieldSchema = z.object({
  recipientKey: RecipientKey,
  kind: z.enum(["signature", "date_signed", "printed_name"]),
  page: z.number().int().min(0).max(199),
  x_ppm: Ppm,
  y_ppm: Ppm,
  w_ppm: Ppm.min(1),
  h_ppm: Ppm.min(1),
  required: z.boolean(),
  origin: z.enum(["detected", "staff"]),
  detectedLabel: z.string().max(200).nullable(),
});

const pageSchema = z.object({
  index: z.number().int().min(0).max(199),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  box_mpt: z.tuple([z.number().int(), z.number().int(), z.number().int().min(1), z.number().int().min(1)]),
});

const sendEnvelopeSchema = z.object({
  clientId: Uuid,
  documentId: Uuid,
  documentType: z.enum(ESIGN_DOC_TYPES),
  engagementId: Uuid.nullable(),
  routing: z.enum(["parallel", "sequential"]),
  recipients: z.array(recipientSchema).min(1).max(10),
  fields: z.array(fieldSchema).max(100),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  pages: z.array(pageSchema).max(200),
  supersedeSiblings: z.boolean().default(false),
  replaceOpen: z.boolean().default(false),
});

// documentType: the type staff picked in the wizard, so the preview's source
// mode follows it. Optional only for callers that have not picked one yet.
const prepareSchema = z.object({ clientId: Uuid, documentId: Uuid, documentType: z.enum(ESIGN_DOC_TYPES).optional() });
const envelopeSchema = z.object({ clientId: Uuid, envelopeId: Uuid });
const reasonSchema = envelopeSchema.extend({ reason: z.string().trim().max(1000).optional() });
const resendSchema = envelopeSchema.extend({ recipientId: Uuid });

function revalidateDocuments() {
  revalidatePath("/portal/documents");
  revalidatePath("/portal");
}

export async function prepareEnvelopeSourceAction(input: {
  clientId: string;
  documentId: string;
  documentType?: string;
}): Promise<PrepareState> {
  try {
    const session = await assertStaff();
    const parsed = prepareSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) return { error: NO_CLIENT_ACCESS };

    const source = await prepareEnvelopeSource(session, parsed.data);
    return { ok: true, source };
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

export async function sendEnvelopeAction(input: SendEnvelopeInput): Promise<SendEnvelopeState> {
  try {
    const session = await assertStaff();
    const parsed = sendEnvelopeSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) return { error: NO_CLIENT_ACCESS };

    const result = await createEnvelope(session, parsed.data);
    revalidateDocuments();
    // Links are returned to the staff caller only, shown once. Raw email errors never surface.
    const activated = result.links.filter((l) => l.url !== null);
    const allEmailed = activated.every((l) => l.emailed);
    return {
      ok: true,
      envelopeId: result.envelopeId,
      links: result.links,
      message: allEmailed
        ? "Sent for signature."
        : "Envelope created, but some emails didn't send. Copy those links below and share them with the signers.",
    };
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

const VOID_OUTCOMES: Record<CloseResult, EsignActionState> = {
  ok: { ok: true, message: "Envelope voided. Every signer's link stops working." },
  expired: { ok: true, message: "That envelope had already expired. The document is no longer out for signature." },
  completing: { error: "Everyone has signed; use Finish sealing instead." },
  completed: { error: "Already completed." },
  declined: { error: "Already closed." },
  voided: { error: "Already closed." },
  not_found: { error: "That signature envelope wasn't found." },
};

export async function voidEnvelopeAction(input: {
  clientId: string;
  envelopeId: string;
  reason?: string;
}): Promise<EsignActionState> {
  try {
    const session = await assertStaff();
    const parsed = reasonSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) return { error: NO_CLIENT_ACCESS };

    const result = await voidEnvelope(session, {
      clientId: parsed.data.clientId,
      envelopeId: parsed.data.envelopeId,
      reason: parsed.data.reason ? parsed.data.reason : null,
    });
    // Every outcome can change what the page shows (an expired envelope is
    // closed and its document restored inside esign_close_envelope).
    revalidateDocuments();
    return VOID_OUTCOMES[result];
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

export async function resendRecipientAction(input: {
  clientId: string;
  envelopeId: string;
  recipientId: string;
}): Promise<ResendRecipientState> {
  try {
    const session = await assertStaff();
    const parsed = resendSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) return { error: NO_CLIENT_ACCESS };

    const result = await resendToRecipient(session, parsed.data);
    revalidateDocuments();
    return {
      ok: true,
      message: result.emailed ? `Link sent to ${result.name}.` : "The email didn't send. Copy the link below.",
      link: { name: result.name, url: result.url, emailed: result.emailed },
    };
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

const FINISH_OUTCOMES: Record<FinishSealingResult, EsignActionState> = {
  completed: { ok: true, message: "Sealed and completed." },
  already_completed: { ok: true, message: "Sealed and completed." },
  sealing_now: { error: "Sealing is already running. Refresh in a minute." },
  backoff: { error: "Sealing didn't finish. Try again in a few minutes, or abandon it after 30 minutes." },
  retry_later: { error: "Sealing didn't finish. Try again in a few minutes, or abandon it after 30 minutes." },
  voided_drift: { error: "A frozen file failed its integrity check, so the envelope was voided. Send a new one." },
  not_completing: { error: NOT_WAITING_TO_SEAL },
};

export async function finishSealingAction(input: { clientId: string; envelopeId: string }): Promise<EsignActionState> {
  try {
    const session = await assertStaff();
    const parsed = envelopeSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) return { error: NO_CLIENT_ACCESS };

    const result = await finishSealing(session, parsed.data);
    revalidateDocuments();
    return FINISH_OUTCOMES[result];
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

const ABANDON_OUTCOMES: Record<AbandonSealResult, EsignActionState> = {
  ok: { ok: true, message: "Sealing abandoned. The envelope is voided and the document restored." },
  too_soon: { error: "Give sealing 30 minutes before abandoning it." },
  sealing_now: { error: SEALING_NOW },
  not_found: { error: NOT_WAITING_TO_SEAL },
  completed: { error: NOT_WAITING_TO_SEAL },
  not_completing: { error: NOT_WAITING_TO_SEAL },
};

export async function abandonSealingAction(input: {
  clientId: string;
  envelopeId: string;
  reason?: string;
}): Promise<EsignActionState> {
  try {
    const session = await assertStaff();
    const parsed = reasonSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) return { error: NO_CLIENT_ACCESS };

    const result = await abandonSealing(session, {
      clientId: parsed.data.clientId,
      envelopeId: parsed.data.envelopeId,
      reason: parsed.data.reason ? parsed.data.reason : null,
    });
    revalidateDocuments();
    return ABANDON_OUTCOMES[result];
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

// Any member with documents access (not only staff). The sealed copy is served
// from the service-role-only esign bucket after an RLS read of the documents
// row proves this viewer can see it.
export async function getSignedCopyUrlAction(documentId: string): Promise<{ url?: string; error?: string }> {
  try {
    const session = await getSession();
    if (!session) return { error: "Please sign in again." };
    if (!Uuid.safeParse(documentId).success) return { error: "Not found." };

    const { url } = await getMemberSealedCopyUrl(session, documentId);
    return { url };
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}
