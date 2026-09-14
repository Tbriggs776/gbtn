import type { SupabaseClient } from "@supabase/supabase-js";
import { getSession, getActiveClient, requireCapability } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PortalHeader, PortalShell, NoClientState } from "@/components/portal/ui";
import { DocumentManager } from "@/components/portal/document-manager";
import type { ClientDocument } from "@/lib/types";
import { visibleDocumentCategories } from "@/lib/permissions";
import {
  ESIGN_DOC_TYPES,
  ESIGN_STATUSES,
  type EsignDocType,
  type EsignStaffData,
  type EsignStatus,
  type EsignTypeSummary,
  type EsignUploaderInfo,
  type StaffRequestSummary,
  type UploaderRole,
} from "@/lib/esign/types";

// Server actions invoked from this page (send for signature downloads, inspects
// and freezes the PDF before calling the RPC) inherit this segment's budget.
export const maxDuration = 60;

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
  // "Sent for signature" vs "Signature link expired" can't flip on hydration.
  const nowIso = new Date().toISOString();

  // E-sign controls are staff-only. Nothing e-sign-specific is fetched for
  // anyone else, and the capability gate above has already run.
  const staff = session?.isStaff
    ? await loadEsignStaffData(supabase, activeClient.id, documents ?? [])
    : null;

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
        />
      </div>
    </PortalShell>
  );
}

const DOC_TYPES: readonly string[] = ESIGN_DOC_TYPES;
const STATUSES: readonly string[] = ESIGN_STATUSES;

function isDocType(v: unknown): v is EsignDocType {
  return typeof v === "string" && DOC_TYPES.includes(v);
}

function isStatus(v: unknown): v is EsignStatus {
  return typeof v === "string" && STATUSES.includes(v);
}

function toUploaderRole(v: unknown): UploaderRole {
  return v === "admin" || v === "employee" || v === "client" ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * The staff-only e-sign view model. Any read error returns null, which hides
 * every e-sign control; it never throws (there is no error.tsx to catch it).
 *
 * The four reads go through the cookie client with an explicit client_id
 * filter — for a platform admin RLS passes every client, so the filter is the
 * tenant boundary. Only uploader roles use the service role: an employee can't
 * read other profiles through RLS, and the caller is already staff and past
 * requireCapability(documents).
 */
async function loadEsignStaffData(
  supabase: SupabaseClient,
  clientId: string,
  documents: ClientDocument[]
): Promise<EsignStaffData | null> {
  try {
    const [types, contacts, engagements, requests] = await Promise.all([
      supabase
        .from("esign_document_type")
        .select("document_type,label,require_sms_otp,activates_engagement,expiry_days,allowed_content_types")
        .eq("esign_enabled", true),
      supabase
        .from("client_contacts")
        .select("id,full_name,title,email,phone,is_primary")
        .eq("client_id", clientId)
        .order("is_primary", { ascending: false })
        .order("full_name"),
      supabase.from("engagements").select("id,name,status").eq("client_id", clientId),
      supabase
        .from("signature_request")
        .select("id,document_id,status,signer_name,signer_email,sent_at,viewed_at,signed_at,expires_at")
        .eq("client_id", clientId)
        .order("sent_at", { ascending: false })
        .limit(200),
    ]);
    if (types.error || contacts.error || engagements.error || requests.error) return null;

    const typeSummaries: EsignTypeSummary[] = [];
    for (const row of types.data ?? []) {
      if (!isDocType(row.document_type)) continue;
      typeSummaries.push({
        documentType: row.document_type,
        label: str(row.label) ?? row.document_type,
        requireSmsOtp: row.require_sms_otp === true,
        activatesEngagement: row.activates_engagement === true,
        expiryDays: typeof row.expiry_days === "number" ? row.expiry_days : 0,
        allowedContentTypes: Array.isArray(row.allowed_content_types)
          ? row.allowed_content_types.filter((t: unknown): t is string => typeof t === "string")
          : [],
      });
    }

    // Rows arrive newest first, so the first row per document is its latest.
    const latestByDocument: Record<string, StaffRequestSummary> = {};
    for (const row of requests.data ?? []) {
      const documentId = str(row.document_id);
      const sentAt = str(row.sent_at);
      const expiresAt = str(row.expires_at);
      if (!documentId || !sentAt || !expiresAt || !isStatus(row.status)) continue;
      if (latestByDocument[documentId]) continue;
      latestByDocument[documentId] = {
        id: String(row.id),
        documentId,
        status: row.status,
        signerName: str(row.signer_name) ?? "",
        signerEmail: str(row.signer_email) ?? "",
        sentAt,
        viewedAt: str(row.viewed_at),
        signedAt: str(row.signed_at),
        expiresAt,
      };
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
      latestByDocument,
      uploaders,
    };
  } catch {
    return null;
  }
}
