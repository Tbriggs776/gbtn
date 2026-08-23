// Shared CRM types, mirroring supabase/migrations/0020_crm.sql + 0021_crm_contact_ltv.sql.
// The CRM is GBTN-internal (platform admin only); there is no client_id here.

/** Discriminated result returned by every CRM server action. */
export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

export const LIFECYCLE_STAGES = [
  "lead",
  "prospect",
  "qualified",
  "opportunity",
  "customer",
  "churned",
  "disqualified",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const LIFECYCLE_LABEL: Record<LifecycleStage, string> = {
  lead: "Lead",
  prospect: "Prospect",
  qualified: "Qualified",
  opportunity: "Opportunity",
  customer: "Customer",
  churned: "Churned",
  disqualified: "Disqualified",
};

export type CrmCompany = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  phone: string | null;
  industry: string | null;
  size: string | null;
  address: Record<string, unknown> | null;
  notes: string | null;
  source: string | null;
  owner: string | null;
  tags: string[];
  custom: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CrmContact = {
  id: string;
  company_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  lifecycle_stage: LifecycleStage;
  source: string | null;
  owner: string | null;
  lead_score: number;
  tags: string[];
  custom: Record<string, unknown>;
  notes: string | null;
  do_not_email: boolean;
  do_not_sms: boolean;
  unsubscribed_at: string | null;
  last_attempt_at: string | null;
  last_contacted_at: string | null;
  last_inbound_at: string | null;
  next_follow_up_at: string | null;
  /** Sum of one_time won deal values. Recurring revenue is in mrr, not here. */
  lifetime_value: number;
  /** Monthly recurring: monthly deals + annual/12. ARR = mrr * 12. */
  mrr: number;
  won_deal_count: number;
  first_won_at: string | null;
  last_won_at: string | null;
  created_at: string;
  updated_at: string;
};

/** A contact joined with its company (for lists/detail). */
export type CrmContactWithCompany = CrmContact & {
  company?: Pick<CrmCompany, "id" | "name"> | null;
};

export type CrmStage = {
  id: string;
  name: string;
  position: number;
  probability: number;
  is_won: boolean;
  is_lost: boolean;
  created_at: string;
};

export const DEAL_STATUSES = ["open", "won", "lost"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const VALUE_TYPES = ["one_time", "monthly", "annual"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export type CrmDeal = {
  id: string;
  title: string;
  company_id: string | null;
  contact_id: string | null;
  stage_id: string | null;
  value: number;
  value_type: ValueType;
  currency: string;
  status: DealStatus;
  owner: string | null;
  expected_close: string | null;
  closed_at: string | null;
  lost_reason: string | null;
  notes: string | null;
  custom: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CrmDealJoined = CrmDeal & {
  company?: Pick<CrmCompany, "id" | "name"> | null;
  contact?: Pick<CrmContact, "id" | "first_name" | "last_name"> | null;
};

export const ACTIVITY_TYPES = [
  "note",
  "task",
  "email",
  "sms",
  "call",
  "meeting",
  "stage_change",
  "form_submission",
  "enrollment",
  "system",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type ActivityDirection = "inbound" | "outbound" | null;

export type CrmActivity = {
  id: number;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  type: ActivityType;
  direction: ActivityDirection;
  subject: string | null;
  body: string | null;
  meta: Record<string, unknown>;
  occurred_at: string;
  created_by: string | null;
  created_at: string;
};

export const TASK_STATUSES = ["open", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type RemindChannel = "none" | "email" | "sms";

export type CrmTask = {
  id: string;
  title: string;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  assignee: string | null;
  due_at: string | null;
  reminder_at: string | null;
  remind_channel: RemindChannel;
  reminded_at: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  notes: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CrmTaskJoined = CrmTask & {
  contact?: Pick<CrmContact, "id" | "first_name" | "last_name"> | null;
};

export type Channel = "email" | "sms";
export const CAMPAIGN_TYPES = ["blast", "drip"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "active",
  "paused",
  "done",
  "archived",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export type CrmCampaign = {
  id: string;
  name: string;
  channel: Channel;
  type: CampaignType;
  status: CampaignStatus;
  subject: string | null;
  from_name: string | null;
  body: string | null;
  audience: Record<string, unknown>;
  scheduled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CrmCampaignStep = {
  id: string;
  campaign_id: string;
  position: number;
  delay_minutes: number;
  channel: Channel;
  subject: string | null;
  body: string;
  created_at: string;
};

export type EnrollmentStatus =
  | "active"
  | "completed"
  | "unsubscribed"
  | "failed"
  | "cancelled";

export type CrmEnrollment = {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: EnrollmentStatus;
  current_step: number;
  next_run_at: string | null;
  enrolled_at: string;
  completed_at: string | null;
};

export type MessageStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "received"
  | "bounced"
  | "opened"
  | "clicked";

export type CrmMessage = {
  id: string;
  contact_id: string | null;
  campaign_id: string | null;
  channel: Channel;
  direction: "inbound" | "outbound";
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body: string | null;
  status: MessageStatus;
  provider: string | null;
  provider_id: string | null;
  error: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

// ── Display helpers ─────────────────────────────────────────

type NameParts = Pick<CrmContact, "first_name" | "last_name"> & { email?: string | null };

export function contactName(c: NameParts): string {
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return name || c.email || "Unnamed contact";
}

export function contactInitials(c: NameParts): string {
  const f = c.first_name?.[0] ?? "";
  const l = c.last_name?.[0] ?? "";
  const init = (f + l).trim();
  if (init) return init.toUpperCase();
  return (c.email?.[0] ?? "?").toUpperCase();
}
