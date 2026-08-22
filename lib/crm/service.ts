import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CrmActivity,
  CrmCampaign,
  CrmCampaignStep,
  CrmCompany,
  CrmContact,
  CrmContactWithCompany,
  CrmDeal,
  CrmDealJoined,
  CrmMessage,
  CrmStage,
  CrmTask,
  CrmTaskJoined,
  LifecycleStage,
} from "./types";

// Data-access layer for the CRM. Every function takes a Supabase client so the
// caller decides the security context: pages/actions pass the RLS-bound server
// client (the admin satisfies the is_admin() policies), while webhooks and cron
// pass the service-role client (no cookie session, RLS bypassed).

type DB = SupabaseClient;

// ── Stages ───────────────────────────────────────────────────────────────────
export async function getStages(db: DB): Promise<CrmStage[]> {
  const { data } = await db.from("crm_stages").select("*").order("position");
  return (data as CrmStage[]) ?? [];
}

// ── Contacts ─────────────────────────────────────────────────────────────────
export type ContactFilter = {
  search?: string;
  stage?: LifecycleStage;
  owner?: string;
  tag?: string;
  limit?: number;
  offset?: number;
};

export async function listContacts(
  db: DB,
  filter: ContactFilter = {}
): Promise<{ rows: CrmContactWithCompany[]; count: number }> {
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  let q = db
    .from("crm_contacts")
    .select("*, company:crm_companies(id, name)", { count: "exact" })
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filter.stage) q = q.eq("lifecycle_stage", filter.stage);
  if (filter.owner) q = q.eq("owner", filter.owner);
  if (filter.tag) q = q.contains("tags", [filter.tag]);
  if (filter.search) {
    const s = filter.search.replace(/[%,]/g, " ").trim();
    q = q.or(
      `first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`
    );
  }
  const { data, count } = await q;
  return { rows: (data as CrmContactWithCompany[]) ?? [], count: count ?? 0 };
}

export async function getContact(
  db: DB,
  id: string
): Promise<CrmContactWithCompany | null> {
  const { data } = await db
    .from("crm_contacts")
    .select("*, company:crm_companies(id, name)")
    .eq("id", id)
    .maybeSingle();
  return (data as CrmContactWithCompany) ?? null;
}

/** Find a contact by email or phone — used to thread inbound comms. */
export async function findContactByEmail(db: DB, email: string): Promise<CrmContact | null> {
  const { data } = await db
    .from("crm_contacts")
    .select("*")
    .ilike("email", email)
    .maybeSingle();
  return (data as CrmContact) ?? null;
}

export async function findContactByPhone(db: DB, phone: string): Promise<CrmContact | null> {
  // Match on the last 10 digits to tolerate +1 / formatting differences.
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (!digits) return null;
  const { data } = await db
    .from("crm_contacts")
    .select("*")
    .ilike("phone", `%${digits}%`)
    .limit(1);
  return ((data as CrmContact[]) ?? [])[0] ?? null;
}

// ── Timeline ─────────────────────────────────────────────────────────────────
export async function getContactTimeline(
  db: DB,
  contactId: string,
  limit = 200
): Promise<CrmActivity[]> {
  const { data } = await db
    .from("crm_activities")
    .select("*")
    .eq("contact_id", contactId)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  return (data as CrmActivity[]) ?? [];
}

export async function getContactMessages(
  db: DB,
  contactId: string,
  limit = 100
): Promise<CrmMessage[]> {
  const { data } = await db
    .from("crm_messages")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as CrmMessage[]) ?? [];
}

// ── Companies ────────────────────────────────────────────────────────────────
export async function listCompanies(db: DB, search?: string): Promise<CrmCompany[]> {
  let q = db.from("crm_companies").select("*").order("name").limit(500);
  if (search) q = q.ilike("name", `%${search}%`);
  const { data } = await q;
  return (data as CrmCompany[]) ?? [];
}

export async function getCompany(db: DB, id: string): Promise<CrmCompany | null> {
  const { data } = await db.from("crm_companies").select("*").eq("id", id).maybeSingle();
  return (data as CrmCompany) ?? null;
}

export async function getCompanyContacts(db: DB, companyId: string): Promise<CrmContact[]> {
  const { data } = await db
    .from("crm_contacts")
    .select("*")
    .eq("company_id", companyId)
    .order("updated_at", { ascending: false });
  return (data as CrmContact[]) ?? [];
}

// ── Deals ────────────────────────────────────────────────────────────────────
export async function listDeals(db: DB, status = "open"): Promise<CrmDealJoined[]> {
  let q = db
    .from("crm_deals")
    .select(
      "*, company:crm_companies(id, name), contact:crm_contacts(id, first_name, last_name)"
    )
    .order("updated_at", { ascending: false });
  if (status !== "all") q = q.eq("status", status);
  const { data } = await q;
  return (data as CrmDealJoined[]) ?? [];
}

export async function getDeal(db: DB, id: string): Promise<CrmDealJoined | null> {
  const { data } = await db
    .from("crm_deals")
    .select(
      "*, company:crm_companies(id, name), contact:crm_contacts(id, first_name, last_name)"
    )
    .eq("id", id)
    .maybeSingle();
  return (data as CrmDealJoined) ?? null;
}

// ── Tasks ────────────────────────────────────────────────────────────────────
export async function listTasks(
  db: DB,
  opts: { status?: string; limit?: number } = {}
): Promise<CrmTaskJoined[]> {
  let q = db
    .from("crm_tasks")
    .select("*, contact:crm_contacts(id, first_name, last_name)")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(opts.limit ?? 200);
  if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
  const { data } = await q;
  return (data as CrmTaskJoined[]) ?? [];
}

export async function getContactTasks(db: DB, contactId: string): Promise<CrmTask[]> {
  const { data } = await db
    .from("crm_tasks")
    .select("*")
    .eq("contact_id", contactId)
    .order("due_at", { ascending: true, nullsFirst: false });
  return (data as CrmTask[]) ?? [];
}

export async function getContactDeals(db: DB, contactId: string): Promise<CrmDeal[]> {
  const { data } = await db
    .from("crm_deals")
    .select("*")
    .eq("contact_id", contactId)
    .order("updated_at", { ascending: false });
  return (data as CrmDeal[]) ?? [];
}

// ── Campaigns ────────────────────────────────────────────────────────────────
export async function listCampaigns(db: DB): Promise<CrmCampaign[]> {
  const { data } = await db
    .from("crm_campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  return (data as CrmCampaign[]) ?? [];
}

export async function getCampaign(db: DB, id: string): Promise<CrmCampaign | null> {
  const { data } = await db.from("crm_campaigns").select("*").eq("id", id).maybeSingle();
  return (data as CrmCampaign) ?? null;
}

export async function getCampaignSteps(db: DB, campaignId: string): Promise<CrmCampaignStep[]> {
  const { data } = await db
    .from("crm_campaign_steps")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("position");
  return (data as CrmCampaignStep[]) ?? [];
}

export async function getCampaignStats(
  db: DB,
  campaignId: string
): Promise<{ enrolled: number; active: number; completed: number; messages: number }> {
  const [{ count: enrolled }, { count: active }, { count: completed }, { count: messages }] =
    await Promise.all([
      db.from("crm_enrollments").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId),
      db.from("crm_enrollments").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("status", "active"),
      db.from("crm_enrollments").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("status", "completed"),
      db.from("crm_messages").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId),
    ]);
  return {
    enrolled: enrolled ?? 0,
    active: active ?? 0,
    completed: completed ?? 0,
    messages: messages ?? 0,
  };
}

// ── Ingest ───────────────────────────────────────────────────────────────────
/**
 * Upsert a website contact-form submission into the CRM: find/create the
 * company, find/create the contact (by email), and append a form_submission
 * activity. Best-effort — call with the service-role client from the public
 * contact action. Never throws to the caller; returns the contact id or null.
 */
export async function ingestFormSubmission(
  db: DB,
  input: {
    name: string;
    email: string;
    company?: string | null;
    revenue?: string | null;
    message: string;
    submissionId?: string | null;
  }
): Promise<string | null> {
  try {
    const email = input.email.trim().toLowerCase();
    let companyId: string | null = null;
    if (input.company?.trim()) {
      const name = input.company.trim();
      const { data: existing } = await db
        .from("crm_companies")
        .select("id")
        .ilike("name", name)
        .limit(1)
        .maybeSingle();
      if (existing?.id) companyId = existing.id as string;
      else {
        const { data: created } = await db
          .from("crm_companies")
          .insert({ name, source: "contact_form" })
          .select("id")
          .single();
        companyId = (created?.id as string) ?? null;
      }
    }

    let contact = await findContactByEmail(db, email);
    if (!contact) {
      const first = input.name.split(" ")[0] || null;
      const last = input.name.split(" ").slice(1).join(" ") || null;
      const { data: created } = await db
        .from("crm_contacts")
        .insert({
          first_name: first,
          last_name: last,
          email,
          company_id: companyId,
          lifecycle_stage: "lead",
          source: "contact_form",
          notes: input.message,
        })
        .select("*")
        .single();
      contact = (created as CrmContact) ?? null;
    } else if (companyId && !contact.company_id) {
      await db.from("crm_contacts").update({ company_id: companyId }).eq("id", contact.id);
    }

    if (!contact) return null;

    await db.from("crm_activities").insert({
      contact_id: contact.id,
      company_id: companyId,
      type: "form_submission",
      direction: "inbound",
      subject: "Website contact form",
      body: input.message,
      meta: { revenue_stage: input.revenue ?? null, source_id: input.submissionId ?? null },
    });
    return contact.id;
  } catch (e) {
    console.error("ingestFormSubmission:", e);
    return null;
  }
}

// ── Dashboard ────────────────────────────────────────────────────────────────
export type CrmDashboard = {
  contactsTotal: number;
  contactsByStage: Record<string, number>;
  openDeals: number;
  pipelineValue: number;
  weightedPipeline: number;
  wonThisMonth: number;
  wonValueThisMonth: number;
  tasksOpen: number;
  tasksOverdue: number;
  msgsSent30d: number;
  needsAttention: CrmContactWithCompany[];
};

export async function getDashboard(db: DB): Promise<CrmDashboard> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thirtyAgo = new Date(now.getTime() - 30 * 864e5).toISOString();

  const [
    stages,
    contactsRes,
    openDealsRes,
    wonRes,
    tasksOpenRes,
    tasksOverdueRes,
    msgsRes,
    stageCounts,
    attention,
  ] = await Promise.all([
    getStages(db),
    db.from("crm_contacts").select("id", { count: "exact", head: true }),
    db.from("crm_deals").select("value, value_type, stage_id, status").eq("status", "open"),
    db.from("crm_deals").select("value").eq("status", "won").gte("closed_at", monthStart),
    db.from("crm_tasks").select("id", { count: "exact", head: true }).eq("status", "open"),
    db.from("crm_tasks").select("id", { count: "exact", head: true }).eq("status", "open").lt("due_at", now.toISOString()),
    db.from("crm_messages").select("id", { count: "exact", head: true }).eq("direction", "outbound").gte("created_at", thirtyAgo),
    db.from("crm_contacts").select("lifecycle_stage"),
    db
      .from("crm_contacts")
      .select("*, company:crm_companies(id, name)")
      .not("next_follow_up_at", "is", null)
      .lte("next_follow_up_at", now.toISOString())
      .order("next_follow_up_at", { ascending: true })
      .limit(10),
  ]);

  const probByStage = new Map(stages.map((s) => [s.id, Number(s.probability)]));
  let pipelineValue = 0;
  let weighted = 0;
  for (const d of (openDealsRes.data as { value: number; stage_id: string | null }[]) ?? []) {
    const v = Number(d.value) || 0;
    pipelineValue += v;
    weighted += v * (d.stage_id ? probByStage.get(d.stage_id) ?? 0 : 0);
  }

  const wonValue = ((wonRes.data as { value: number }[]) ?? []).reduce(
    (a, r) => a + (Number(r.value) || 0),
    0
  );

  const byStage: Record<string, number> = {};
  for (const r of (stageCounts.data as { lifecycle_stage: string }[]) ?? []) {
    byStage[r.lifecycle_stage] = (byStage[r.lifecycle_stage] ?? 0) + 1;
  }

  return {
    contactsTotal: contactsRes.count ?? 0,
    contactsByStage: byStage,
    openDeals: (openDealsRes.data ?? []).length,
    pipelineValue,
    weightedPipeline: weighted,
    wonThisMonth: (wonRes.data ?? []).length,
    wonValueThisMonth: wonValue,
    tasksOpen: tasksOpenRes.count ?? 0,
    tasksOverdue: tasksOverdueRes.count ?? 0,
    msgsSent30d: msgsRes.count ?? 0,
    needsAttention: (attention.data as CrmContactWithCompany[]) ?? [],
  };
}
