import type { SupabaseClient } from "@supabase/supabase-js";
import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { DocumentManager } from "@/components/portal/document-manager";
import type { ClientDocument } from "@/lib/types";
import { visibleDocumentCategories } from "@/lib/permissions";
import { listStaffSigners } from "@/lib/esign/engine";
import {
  ENVELOPE_STATUSES,
  ESIGN_DOC_TYPES,
  RECIPIENT_STATUSES,
  type EnvelopeStatus,
  type EnvelopeSummary,
  type EsignDocType,
  type EsignStaffData,
  type EsignTypeSummary,
  type EsignUploaderInfo,
  type RecipientKind,
  type RecipientStatus,
  type RecipientSummary,
  type RoutingMode,
  type SealingMode,
  type SignatureMethod,
  type SourceMode,
  type UploaderRole,
} from "@/lib/esign/types";

// Server actions invoked from this page inherit this segment's budget. Send
// downloads, sniffs, converts and freezes the source before the RPC, and staff
// "Finish sealing" builds the whole sealed envelope in the action (C11), so the
// budget matches the seal route's 300 s.
export const maxDuration = 300;

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientParam } = await searchParams;
  const session = await getSession();
  const activeClient = await getActiveClient(clientParam);
  // Gate before any data fetch: dashboards read via the service role,
  // which bypasses RLS, so this is the real enforcement point.
  if (activeClient) await requireCapability(activeClient.id, "documents");

  if (!activeClient) {
    return (
      <PortalShell>
        <PortalHeader title="Documents" />
        <div className="mt-8">
          <NoClientState isAdmin={Boolean(session?.isAdmin)} />
        </div>
      </PortalShell>
    );
  }

  const supabase = await createClient();
  // RLS already withholds Financials-category rows from ops/marketing, but the
  // filter is repeated here so the page does not depend on that alone — every
  // other dashboard reads through the service role, and this one is one
  // refactor away from doing the same.
  const { all: allCategories, hidden } = visibleDocumentCategories(
    session ? session.roles[activeClient.id] : null,
    Boolean(session?.isAdmin)
  );
  let query = supabase
    .from("documents")
    .select("*")
    .eq("client_id", activeClient.id);
  if (!allCategories) query = query.not("category", "in", `(${hidden.join(",")})`);
  const { data: documents } = await query
    .order("created_at", { ascending: false })
    .returns<ClientDocument[]>();

  // One timestamp for every label and eligibility call, server and client, so
  // "In progress" vs "Expired" can't flip on hydration.
  const nowIso = new Date().toISOString();

  // E-sign controls are staff-only. Nothing e-sign-specific is fetched for
  // anyone else, and the capability gate above has already run.
  const staff = session?.isStaff
    ? await loadEsignStaffData(supabase, activeClient.id, documents ?? [])
    : null;

  // The legal name feeds signature-block detection in the send wizard, so it
  // is only read when the wizard can open.
  const clientLegalName = staff
    ? await loadClientLegalName(supabase, activeClient.id, activeClient.name)
    : activeClient.name;

  return (
    <PortalShell>
      <PortalHeader
        title="Documents"
        subtitle={`${activeClient.name} · share files securely with Tyler`}
      />
      <div className="mt-8">
        <DocumentManager
          clientId={activeClient.id}
          documents={documents ?? []}
          canUploadFinancials={allCategories}
          staff={staff}
          nowIso={nowIso}
          clientLegalName={clientLegalName}
        />
      </div>
    </PortalShell>
  );
}

const DOC_TYPES: readonly string[] = ESIGN_DOC_TYPES;
const ENV_STATUSES: readonly string[] = ENVELOPE_STATUSES;
const REC_STATUSES: readonly string[] = RECIPIENT_STATUSES;

function isDocType(v: unknown): v is EsignDocType {
  return typeof v === "string" && DOC_TYPES.includes(v);
}

function isEnvelopeStatus(v: unknown): v is EnvelopeStatus {
  return typeof v === "string" && ENV_STATUSES.includes(v);
}

function isRecipientStatus(v: unknown): v is RecipientStatus {
  return typeof v === "string" && REC_STATUSES.includes(v);
}

function toRouting(v: unknown): RoutingMode | null {
  return v === "parallel" || v === "sequential" ? v : null;
}

function toSourceMode(v: unknown): SourceMode | null {
  return v === "pdf" || v === "image_pdf" || v === "certificate" ? v : null;
}

function toSealingMode(v: unknown): SealingMode {
  return v === "page" || v === "certificate" ? v : "auto";
}

function toRecipientKind(v: unknown): RecipientKind | null {
  return v === "client_contact" || v === "outside" || v === "staff" ? v : null;
}

function toMethod(v: unknown): SignatureMethod | null {
  return v === "drawn" || v === "typed" ? v : null;
}

function toUploaderRole(v: unknown): UploaderRole {
  return v === "admin" || v === "employee" || v === "client" ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/** legal_name ?? name. Any read error falls back to the display name. */
async function loadClientLegalName(
  supabase: SupabaseClient,
  clientId: string,
  fallback: string
): Promise<string> {
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("legal_name")
      .eq("id", clientId)
      .maybeSingle();
    if (error || !data) return fallback;
    const legal = str(data.legal_name)?.trim();
    return legal ? legal : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The staff-only e-sign view model. Any read error returns null, which hides
 * every e-sign control; it never throws (there is no error.tsx to catch it).
 *
 * Every table read goes through the cookie client with an explicit client_id
 * filter — for a platform admin RLS passes every client, so the filter is the
 * tenant boundary — and names its columns, because column-level grants make
 * select("*") fail on the e-sign tables. The service role is used only for
 * uploader roles and the countersigner list: the caller is already staff and
 * past requireCapability(documents).
 */
async function loadEsignStaffData(
  supabase: SupabaseClient,
  clientId: string,
  documents: ClientDocument[]
): Promise<EsignStaffData | null> {
  try {
    const [types, contacts, engagements, envelopes] = await Promise.all([
      supabase
        .from("esign_document_type")
        .select(
          "document_type,label,require_sms_otp,activates_engagement,expiry_days,allowed_content_types,sealing_mode,max_recipients,allow_typed_signature,allow_outside_signers"
        )
        .eq("esign_enabled", true),
      supabase
        .from("client_contacts")
        .select("id,full_name,title,email,phone,is_primary")
        .eq("client_id", clientId)
        .order("is_primary", { ascending: false })
        .order("full_name"),
      supabase.from("engagements").select("id,name,status").eq("client_id", clientId),
      supabase
        .from("signature_envelope")
        .select(
          "id,document_id,status,routing_mode,source_mode,sent_at,expires_at,completed_at,completing_at,seal_attempts,seal_next_attempt_at"
        )
        .eq("client_id", clientId)
        .order("sent_at", { ascending: false })
        .limit(200),
    ]);
    if (types.error || contacts.error || engagements.error || envelopes.error) return null;

    const typeSummaries: EsignTypeSummary[] = [];
    for (const row of types.data ?? []) {
      if (!isDocType(row.document_type)) continue;
      typeSummaries.push({
        documentType: row.document_type,
        label: str(row.label) ?? row.document_type,
        requireSmsOtp: row.require_sms_otp === true,
        activatesEngagement: row.activates_engagement === true,
        expiryDays: int(row.expiry_days, 0),
        allowedContentTypes: Array.isArray(row.allowed_content_types)
          ? row.allowed_content_types.filter((t: unknown): t is string => typeof t === "string")
          : [],
        sealingMode: toSealingMode(row.sealing_mode),
        maxRecipients: Math.min(10, Math.max(1, int(row.max_recipients, 1))),
        allowTypedSignature: row.allow_typed_signature === true,
        allowOutsideSigners: row.allow_outside_signers === true,
      });
    }

    // Rows arrive newest first, so the first row per document is its latest.
    const envelopesByDocument: Record<string, EnvelopeSummary> = {};
    for (const row of envelopes.data ?? []) {
      const documentId = str(row.document_id);
      const sentAt = str(row.sent_at);
      const expiresAt = str(row.expires_at);
      const routing = toRouting(row.routing_mode);
      const sourceMode = toSourceMode(row.source_mode);
      if (!documentId || !sentAt || !expiresAt || !routing || !sourceMode) continue;
      if (!isEnvelopeStatus(row.status)) continue;
      if (envelopesByDocument[documentId]) continue;
      envelopesByDocument[documentId] = {
        id: String(row.id),
        documentId,
        status: row.status,
        routing,
        sourceMode,
        sentAt,
        expiresAt,
        completedAt: str(row.completed_at),
        completingAt: str(row.completing_at),
        sealAttempts: int(row.seal_attempts, 0),
        sealNextAttemptAt: str(row.seal_next_attempt_at),
        recipients: [],
      };
    }

    const latestIds = Object.values(envelopesByDocument).map((e) => e.id);
    if (latestIds.length > 0) {
      const { data: recipients, error } = await supabase
        .from("signature_recipient")
        .select("id,envelope_id,kind,routing_order,name,email,status,activated_at,viewed_at,signed_at,signature_method")
        .in("envelope_id", latestIds)
        .eq("client_id", clientId);
      if (error) return null;

      const byEnvelope = new Map<string, RecipientSummary[]>();
      for (const r of recipients ?? []) {
        const envelopeId = str(r.envelope_id);
        const kind = toRecipientKind(r.kind);
        if (!envelopeId || !kind || !isRecipientStatus(r.status)) continue;
        const list = byEnvelope.get(envelopeId) ?? [];
        list.push({
          id: String(r.id),
          kind,
          order: int(r.routing_order, 1),
          name: str(r.name) ?? "",
          email: str(r.email) ?? "",
          status: r.status,
          activatedAt: str(r.activated_at),
          viewedAt: str(r.viewed_at),
          signedAt: str(r.signed_at),
          method: toMethod(r.signature_method),
        });
        byEnvelope.set(envelopeId, list);
      }
      for (const envelope of Object.values(envelopesByDocument)) {
        envelope.recipients = (byEnvelope.get(envelope.id) ?? []).sort(
          (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
      }
    }

    const uploaders: Record<string, EsignUploaderInfo> = {};
    const uploaderIds = [
      ...new Set(documents.map((d) => d.uploaded_by).filter((id): id is string => Boolean(id))),
    ];
    if (uploaderIds.length > 0) {
      const admin = createAdminClient();
      const { data: profiles, error } = await admin
        .from("profiles")
        .select("id,full_name,role")
        .in("id", uploaderIds);
      if (error) return null;
      for (const p of profiles ?? []) {
        uploaders[String(p.id)] = { name: str(p.full_name), role: toUploaderRole(p.role) };
      }
    }

    // Platform admins only (S1). Service role inside the engine; never throws
    // out of this function because it sits inside the try.
    const staffSigners = await listStaffSigners(clientId);

    return {
      clientId,
      types: typeSummaries,
      contacts: (contacts.data ?? []).map((c) => ({
        id: String(c.id),
        full_name: str(c.full_name) ?? "",
        title: str(c.title),
        email: str(c.email),
        phone: str(c.phone),
        is_primary: c.is_primary === true,
      })),
      engagements: (engagements.data ?? []).map((e) => ({
        id: String(e.id),
        name: str(e.name) ?? "",
        status: str(e.status) ?? "",
      })),
      staffSigners,
      envelopesByDocument,
      uploaders,
    };
  } catch {
    return null;
  }
}
