"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { assertStaff, getSession, sessionCan } from "@/lib/auth";
import { staffMessage } from "@/lib/esign/errors";
import { ESIGN_DOC_TYPES, type SendForSignatureInput } from "@/lib/esign/types";
import {
  createSignatureRequest,
  getMemberSealedCopyUrl,
  resendSignatureRequest,
  voidSignatureRequest,
  type CreateSignatureResult,
  type VoidResult,
} from "@/lib/esign/engine";

// Staff e-sign actions for the Documents page. Every export wraps EVERYTHING —
// including assertStaff()/getSession() — in one try, so a non-staff caller gets
// { error } instead of a thrown action. unstable_rethrow lets a signed-out
// redirect from requireSession propagate. Messages come from staffMessage,
// which never returns a raw DB error.
//
// The sessionCan check here is on the client id the caller named; the engine
// re-checks it against the document's (or request's) real client_id before it
// touches the service role for anything tenant-scoped.

export type EsignActionState = { ok?: boolean; error?: string; message?: string; signUrl?: string };

const FORM_ERROR = "Check the form and try again.";
const NO_CLIENT_ACCESS = "You don't have access to this client.";

const sendSchema = z.object({
  clientId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentType: z.enum(ESIGN_DOC_TYPES),
  engagementId: z.string().uuid().nullable(),
  signer: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("contact"), contactId: z.string().uuid() }),
    z.object({
      kind: z.literal("manual"),
      fullName: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email().max(254),
      phone: z.string().trim().max(32).optional(),
    }),
  ]),
  supersedeSiblings: z.boolean().default(false),
});

const voidSchema = z.object({
  clientId: z.string().uuid(),
  requestId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional(),
});

const resendSchema = z.object({
  clientId: z.string().uuid(),
  requestId: z.string().uuid(),
});

function revalidateDocuments() {
  revalidatePath("/portal/documents");
  revalidatePath("/portal");
}

// The link is returned to the staff caller only, shown once in the dialog. The
// raw email error is never surfaced.
function createdState(r: CreateSignatureResult): EsignActionState {
  return {
    ok: true,
    signUrl: r.signUrl,
    message: r.emailed
      ? "Sent for signature."
      : "Request created, but the email didn't send. Copy the link below and share it with the signer.",
  };
}

export async function sendForSignatureAction(
  input: SendForSignatureInput
): Promise<EsignActionState> {
  try {
    const session = await assertStaff();
    const parsed = sendSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) {
      return { error: NO_CLIENT_ACCESS };
    }

    const result = await createSignatureRequest(session, parsed.data, { replaceOpen: false });
    revalidateDocuments();
    return createdState(result);
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

const VOID_OUTCOMES: Record<VoidResult, EsignActionState> = {
  ok: { ok: true, message: "Request voided. The link no longer works." },
  not_found: { error: "That signature request wasn't found." },
  expired: {
    error:
      "That link had already expired, so there was nothing to void. The document is no longer out for signature.",
  },
  signed: { error: "Already signed. A signed request can't be voided." },
  declined: { error: "The signer already declined this request." },
  voided: { error: "This request was already voided." },
  // Staff voids never carry an OTP session, and the SQL only asks for one on declines.
  otp_required: { error: "Something went wrong. Refresh and try again." },
};

export async function voidSignatureRequestAction(input: {
  clientId: string;
  requestId: string;
  reason?: string;
}): Promise<EsignActionState> {
  try {
    const session = await assertStaff();
    const parsed = voidSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) {
      return { error: NO_CLIENT_ACCESS };
    }

    const result = await voidSignatureRequest(session, {
      clientId: parsed.data.clientId,
      requestId: parsed.data.requestId,
      reason: parsed.data.reason ? parsed.data.reason : null,
    });
    // Every outcome can change what the page shows (an expired row is restored
    // by the lazy sweep inside esign_close_request), so always revalidate.
    revalidateDocuments();
    return VOID_OUTCOMES[result];
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

export async function resendSignatureRequestAction(input: {
  clientId: string;
  requestId: string;
}): Promise<EsignActionState> {
  try {
    const session = await assertStaff();
    const parsed = resendSchema.safeParse(input);
    if (!parsed.success) return { error: FORM_ERROR };
    if (!sessionCan(session, parsed.data.clientId, "documents")) {
      return { error: NO_CLIENT_ACCESS };
    }

    const result = await resendSignatureRequest(session, parsed.data);
    revalidateDocuments();
    return createdState(result);
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}

// Any member with documents access (not only staff). The sealed copy is served
// from the service-role-only esign bucket after an RLS read of the documents
// row proves this viewer can see it; the client-files convenience copy is never
// served (members can write under their own client prefix).
export async function getSignedCopyUrlAction(
  documentId: string
): Promise<{ url?: string; error?: string }> {
  try {
    const session = await getSession();
    if (!session) return { error: "Please sign in again." };
    if (!z.string().uuid().safeParse(documentId).success) return { error: "Not found." };

    const { url } = await getMemberSealedCopyUrl(session, documentId);
    return { url };
  } catch (e) {
    unstable_rethrow(e);
    return { error: staffMessage(e) };
  }
}
