import { OFFER_RUNGS, RUNG_LABEL, type OfferRung } from "@/lib/crm/types";

// View-model rules for the client portal home (Advantage OS Phase 2: Run/Prove).
//
// Plain module on purpose — no "server-only", no "use client", no React, no
// Supabase — so the loader and the home components share ONE definition of
// "primary engagement", "current phase" and "open".
//
// Three rules shape everything here:
//  - Status vocabularies are OPEN. 0029 has no CHECK constraint on any status
//    column, so every set below is a lookup with a fallback, never an exhaustive
//    enum. The one real engagement in production is `pending_signature`, so an
//    `active`-only filter would render nothing.
//  - Date-only columns are compared and formatted as 'YYYY-MM-DD' strings. A
//    `new Date("2026-09-14")` parses as UTC midnight and renders Sep 13 in
//    Arizona — never parse a date-only value with Date.
//  - Supabase rows arrive untyped, so parse* does real runtime narrowing and
//    re-checks tenant scope. Nothing past the parsers is `any`.

// ── Dates ─────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today in the client's timezone as 'YYYY-MM-DD'. America/Phoenix is UTC-7 with
 * no DST, so a fixed offset is exact. A client in a DST timezone would need a
 * per-client timezone (same caveat as lib/ghl/metrics.ts).
 */
export function arizonaToday(now: Date = new Date()): string {
  return new Date(now.getTime() - 7 * 3_600_000).toISOString().slice(0, 10);
}

/** A date-only column value as 'YYYY-MM-DD', or null for anything else. */
export function isoDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const day = v.slice(0, 10);
  return DAY_RE.test(day) ? day : null;
}

/** 'YYYY-MM-DD' → 'Sep 14, 2026'. String surgery, so no timezone shift. */
export function fmtDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
}

/** Whole days from a to b, via Date.UTC on the parts (never a date-only parse). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

// ── Vocabulary ────────────────────────────────────────────────────────────────

export function normalizeStatus(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** 'week_3' → 'Week 3'; empty → null. */
export function humanize(v: unknown): string | null {
  const words = normalizeStatus(v).split("_").filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function isOfferRungValue(s: string): s is OfferRung {
  return (OFFER_RUNGS as readonly string[]).includes(s);
}

export function toOfferRung(v: unknown): OfferRung | null {
  const s = normalizeStatus(v);
  return isOfferRungValue(s) ? s : null;
}

export type StatusTone = "live" | "upcoming" | "paused" | "neutral" | "alert";
export type EngagementBucket = "live" | "upcoming" | "other" | "paused" | "terminal";

const ENG_LIVE = new Set(["active", "in_progress", "ongoing", "live", "current", "started", "underway", "renewed"]);
const ENG_UPCOMING = new Set([
  "pending_signature", "awaiting_signature", "pending", "sent", "signed", "contracted",
  "scheduled", "onboarding", "kickoff", "not_started", "proposed", "draft",
]);
const ENG_PAUSED = new Set(["paused", "on_hold", "hold", "suspended"]);
/** Terminal because the work finished — feeds "your previous engagement is complete". */
const ENG_COMPLETED = new Set(["complete", "completed", "done", "closed", "ended", "expired"]);
/** Terminal without finishing — removed, but never counted as "complete". */
const ENG_CLOSED_OTHER = new Set([
  "terminated", "cancelled", "canceled", "churned", "lost", "declined",
  "void", "voided", "archived", "inactive", "superseded",
]);
/** Never ranked as primary for anyone; admins see a count instead. */
const ENG_DRAFTS = new Set(["draft", "proposed"]);

/** Draft engagements are hidden from the portal home, so staff counts skip them too. */
export function isDraftEngagementStatus(status: string): boolean {
  return ENG_DRAFTS.has(status);
}

export function engagementBucket(status: string): EngagementBucket {
  if (ENG_COMPLETED.has(status) || ENG_CLOSED_OTHER.has(status)) return "terminal";
  if (ENG_LIVE.has(status)) return "live";
  if (ENG_UPCOMING.has(status)) return "upcoming";
  if (ENG_PAUSED.has(status)) return "paused";
  return "other";
}

const ENG_STATUS_LABEL = new Map<string, string>([
  ["active", "Active"], ["in_progress", "In progress"], ["ongoing", "Ongoing"], ["live", "Live"],
  ["current", "Current"], ["started", "Started"], ["underway", "Underway"], ["renewed", "Renewed"],
  ["pending_signature", "Awaiting signature"], ["awaiting_signature", "Awaiting signature"],
  ["pending", "Pending"], ["sent", "Sent for signature"], ["signed", "Signed"],
  ["contracted", "Contracted"], ["scheduled", "Scheduled"], ["onboarding", "Onboarding"],
  ["kickoff", "Kickoff"], ["not_started", "Not started"],
  ["paused", "Paused"], ["on_hold", "On hold"], ["hold", "On hold"], ["suspended", "Suspended"],
]);

/** Client-facing status. Never echoes an unmapped raw value. */
export function engagementStatusLabel(status: string): string {
  return ENG_STATUS_LABEL.get(status) ?? "Open";
}

const TYPE_LABEL = new Map<string, string>([
  ["fractional_cfo", "Fractional CFO"],
  ["fractional_coo", "Fractional COO"],
  ["fractional_cfo_coo", "Fractional CFO + COO"],
  ["fractional_coo_cfo", "Fractional CFO + COO"],
]);

/** Client-facing engagement type. Allowlist only; anything else is hidden. */
export function clientTypeLabel(engagementType: string | null): string | null {
  return TYPE_LABEL.get(normalizeStatus(engagementType)) ?? null;
}

const TONE_BY_BUCKET: Record<Exclude<EngagementBucket, "terminal">, StatusTone> = {
  live: "live",
  upcoming: "upcoming",
  paused: "paused",
  other: "neutral",
};

// ── Sanitized rows ────────────────────────────────────────────────────────────

export type EngagementRow = {
  id: string;
  clientId: string;
  name: string;
  engagementType: string | null;
  status: string;
  startDate: string | null;
  termEnd: string | null;
  createdAt: string;
  offerRung: OfferRung | null;
  /** Converted from a CRM deal — its raw name is a deal title and is masked. */
  fromDeal: boolean;
};

export type PhaseRow = {
  id: string;
  sequence: number;
  name: string;
  purpose: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: string;
};

export type DeliverableRow = {
  id: string;
  phaseId: string;
  sequence: number;
  name: string;
  status: string;
  dueOn: string | null;
  deliveredOn: string | null;
};

export type OnboardingRow = {
  id: string;
  category: string;
  item: string;
  priority: string | null;
  owner: "client" | "gbtn";
  status: string;
  requestedOn: string | null;
  receivedOn: string | null;
};

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function recs(data: unknown): Rec[] {
  return Array.isArray(data) ? data.filter(isRec) : [];
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** A sequence number, or +Infinity so bad values sort last instead of first. */
function seqOf(v: unknown): number {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

export function parseEngagementRows(data: unknown, clientId: string, has0030: boolean): EngagementRow[] {
  const out: EngagementRow[] = [];
  for (const r of recs(data)) {
    const id = text(r.id);
    // Tenant re-check: a platform admin's RLS grants SELECT on every client.
    if (!id || r.client_id !== clientId) continue;
    const engagementType = text(r.engagement_type);
    out.push({
      id,
      clientId,
      name: text(r.name) ?? "Untitled engagement",
      engagementType,
      status: normalizeStatus(r.status),
      startDate: isoDay(r.start_date),
      termEnd: isoDay(r.initial_term_end),
      createdAt: typeof r.created_at === "string" ? r.created_at : "",
      offerRung: has0030 ? toOfferRung(r.offer_rung) : null,
      // crm_deal_id is reduced to this boolean and never copied anywhere. The
      // second arm is the convert flow's own marker (lib/crm/engagements.ts sets
      // engagement_type to the rung), which still catches a deal-named row after
      // `on delete set null` cleared crm_deal_id, and on the pre-0030 path.
      fromDeal:
        (has0030 && typeof r.crm_deal_id === "string" && r.crm_deal_id !== "") ||
        isOfferRungValue(normalizeStatus(engagementType)),
    });
  }
  return out;
}

export function parsePhaseRows(data: unknown, engagementId: string): PhaseRow[] {
  const out: PhaseRow[] = [];
  for (const r of recs(data)) {
    const id = text(r.id);
    if (!id || r.engagement_id !== engagementId) continue;
    out.push({
      id,
      sequence: seqOf(r.sequence),
      name: text(r.name) ?? "Untitled phase",
      purpose: text(r.purpose),
      startsOn: isoDay(r.starts_on),
      endsOn: isoDay(r.ends_on),
      status: normalizeStatus(r.status),
    });
  }
  return out;
}

export function parseDeliverableRows(data: unknown, phaseIds: ReadonlySet<string>): DeliverableRow[] {
  const out: DeliverableRow[] = [];
  for (const r of recs(data)) {
    const id = text(r.id);
    const phaseId = text(r.phase_id);
    if (!id || !phaseId || !phaseIds.has(phaseId)) continue;
    out.push({
      id,
      phaseId,
      sequence: seqOf(r.sequence),
      name: text(r.name) ?? "Untitled deliverable",
      status: normalizeStatus(r.status),
      dueOn: isoDay(r.due_on),
      deliveredOn: isoDay(r.delivered_on),
    });
  }
  return out;
}

export function parseOnboardingRows(data: unknown, clientId: string, engagementId: string): OnboardingRow[] {
  const out: OnboardingRow[] = [];
  for (const r of recs(data)) {
    const id = text(r.id);
    if (!id || r.client_id !== clientId || r.engagement_id !== engagementId) continue;
    out.push({
      id,
      category: text(r.category) ?? "",
      item: text(r.item) ?? "Untitled request",
      priority: text(r.priority) ? normalizeStatus(r.priority) : null,
      owner: normalizeStatus(r.owner) === "gbtn" ? "gbtn" : "client",
      status: normalizeStatus(r.status),
      requestedOn: isoDay(r.requested_on),
      receivedOn: isoDay(r.received_on),
    });
  }
  return out;
}

// ── Primary engagement ───────────────────────────────────────────────────────

const BUCKET_RANK: Record<Exclude<EngagementBucket, "terminal">, number> = {
  live: 0,
  upcoming: 1,
  other: 2,
  paused: 3,
};

function ascNullsLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function descNullsLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

function tieBreak(a: EngagementRow, b: EngagementRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type PrimarySelection = {
  primary: EngagementRow | null;
  otherOpenCount: number;
  completedCount: number;
  hiddenDraftCount: number;
};

/**
 * The engagement the home leads with. Ranks LIVE statuses rather than filtering
 * to `active`: live (active, in progress…) beats upcoming (pending_signature,
 * scheduled…) beats unrecognised beats paused. Terminal rows and drafts never
 * rank. Identical for every viewer.
 */
export function selectPrimaryEngagement(rows: EngagementRow[], opts: { today: string }): PrimarySelection {
  const today = opts.today;
  let completedCount = 0;
  let hiddenDraftCount = 0;
  const open: { row: EngagementRow; bucket: Exclude<EngagementBucket, "terminal"> }[] = [];

  for (const row of rows) {
    const bucket = engagementBucket(row.status);
    if (bucket === "terminal") {
      if (ENG_COMPLETED.has(row.status)) completedCount++;
      continue;
    }
    if (ENG_DRAFTS.has(row.status)) {
      hiddenDraftCount++;
      continue;
    }
    open.push({ row, bucket });
  }

  open.sort((x, y) => {
    const rank = BUCKET_RANK[x.bucket] - BUCKET_RANK[y.bucket];
    if (rank !== 0) return rank;
    const a = x.row;
    const b = y.row;

    if (x.bucket === "live") {
      // Already running beats an `active` renewal row that starts next month.
      const aStarted = a.startDate === null || a.startDate <= today ? 0 : 1;
      const bStarted = b.startDate === null || b.startDate <= today ? 0 : 1;
      if (aStarted !== bStarted) return aStarted - bStarted;
      return descNullsLast(a.startDate, b.startDate) || tieBreak(a, b);
    }

    if (x.bucket === "upcoming") {
      // Next to start first, then the most recently planned, then undated.
      const group = (s: string | null) => (s === null ? 2 : s >= today ? 0 : 1);
      const ga = group(a.startDate);
      const gb = group(b.startDate);
      if (ga !== gb) return ga - gb;
      const byDate =
        ga === 0 ? ascNullsLast(a.startDate, b.startDate) : ga === 1 ? descNullsLast(a.startDate, b.startDate) : 0;
      return byDate || tieBreak(a, b);
    }

    return descNullsLast(a.startDate, b.startDate) || tieBreak(a, b);
  });

  return {
    primary: open.length > 0 ? open[0].row : null,
    otherOpenCount: Math.max(0, open.length - 1),
    completedCount,
    hiddenDraftCount,
  };
}

// ── Engagement view model ────────────────────────────────────────────────────

export type PortalEngagement = {
  id: string;
  /** Client-visible name, identical for every viewer. */
  name: string;
  /** Allowlisted type label, identical for every viewer. */
  typeLabel: string | null;
  statusLabel: string;
  bucket: Exclude<EngagementBucket, "terminal">;
  tone: StatusTone;
  /** Null renders as "Rung unset" — the card always shows. */
  rung: OfferRung | null;
  rungLabel: string | null;
  timeline: string | null;
  termDay: { day: number; of: number } | null;
  /** Null unless the viewer is a platform admin — the only place raw values live. */
  staff: {
    /** Converted from a CRM deal: the client-visible name follows the rung. */
    fromDeal: boolean;
    internalName: string | null;
    rawStatus: string | null;
    rawType: string | null;
  } | null;
};

function engagementTimeline(start: string | null, end: string | null, live: boolean, today: string): string | null {
  let lead: string | null = null;
  if (start !== null) {
    if (start > today) lead = `Starts ${fmtDay(start)}`;
    else if (start === today) lead = "Starts today";
    else lead = live ? `Started ${fmtDay(start)}` : `Planned start ${fmtDay(start)}`;
  }

  let tail: string | null = null;
  if (end !== null) {
    if (today <= end) tail = `initial term through ${fmtDay(end)}`;
    // A live engagement past its initial term is auto-renewing, not "ended".
    else if (!live) tail = `initial term ended ${fmtDay(end)}`;
  }

  if (lead && tail) return `${lead} · ${tail}`;
  if (tail) return tail.charAt(0).toUpperCase() + tail.slice(1);
  return lead;
}

export function toPortalEngagement(row: EngagementRow, today: string, viewer: { isAdmin: boolean }): PortalEngagement {
  const b = engagementBucket(row.status);
  // selectPrimaryEngagement has already removed terminal rows; this is only a type guard.
  const bucket: Exclude<EngagementBucket, "terminal"> = b === "terminal" ? "other" : b;
  const rung = row.offerRung;
  const normType = normalizeStatus(row.engagementType);

  let typeLabel = clientTypeLabel(row.engagementType);
  let name = row.name;
  if (row.fromDeal) {
    // A deal-converted engagement is named after the CRM deal. Firm pipeline
    // text never reaches a client: show a neutral name instead.
    if (rung) {
      name = `${RUNG_LABEL[rung]} engagement`;
    } else if (typeLabel) {
      name = `${typeLabel} engagement`;
      typeLabel = null; // already in the name
    } else {
      name = "Your GBTN engagement";
    }
  }

  const live = bucket === "live";
  const s = row.startDate;
  const e = row.termEnd;

  return {
    id: row.id,
    name,
    typeLabel,
    statusLabel: engagementStatusLabel(row.status),
    bucket,
    tone: TONE_BY_BUCKET[bucket],
    rung,
    rungLabel: rung ? RUNG_LABEL[rung] : null,
    timeline: engagementTimeline(s, e, live, today),
    termDay:
      live && s !== null && e !== null && s <= today && today <= e
        ? { day: daysBetween(s, today) + 1, of: daysBetween(s, e) + 1 }
        : null,
    staff: viewer.isAdmin
      ? {
          fromDeal: row.fromDeal,
          internalName: row.fromDeal && row.name !== name ? row.name : null,
          rawStatus: ENG_STATUS_LABEL.has(row.status) ? null : row.status || "(not set)",
          rawType:
            normType !== "" && !isOfferRungValue(normType) && !TYPE_LABEL.has(normType) ? normType : null,
        }
      : null,
  };
}

// ── Cadence ──────────────────────────────────────────────────────────────────

const PHASE_DONE = new Set([
  "complete", "completed", "done", "closed", "delivered", "skipped", "cancelled", "canceled",
  "waived", "not_applicable", "n_a", "na", "superseded",
]);
const PHASE_ACTIVE = new Set(["in_progress", "active", "underway", "started", "ongoing", "current"]);
const PHASE_HOLD = new Set(["paused", "on_hold", "hold", "blocked"]);
const DELIVERABLE_DONE = new Set([...PHASE_DONE, "accepted", "approved"]);
const ONBOARDING_DONE = new Set([
  "received", "waived", "done", "complete", "completed", "closed", "cancelled", "canceled",
  "not_needed", "not_applicable", "n_a", "na",
]);

const PRIORITY_RANK = new Map<string, number>([["day_1", 0], ["week_1", 1], ["week_2", 2]]);
const PRIORITY_LABEL = new Map<string, string>([["day_1", "Day 1"], ["week_1", "Week 1"], ["week_2", "Week 2"]]);

/** How the current phase was chosen: today's date window, an in-progress status, or sequence. */
export type PhaseBasis = "dates" | "status" | "sequence";

export type CadencePhase = {
  id: string;
  ordinal: number;
  name: string;
  purpose: string | null;
  statusLabel: string | null;
  statusTone: StatusTone;
  dateLabel: string | null;
  isOngoing: boolean;
  deliverableTotal: number;
  deliverableDone: number;
};

export type CadenceDeliverable = {
  id: string;
  name: string;
  phaseOrdinal: number;
  inCurrentPhase: boolean;
  dueLabel: string | null;
  overdue: boolean;
};

export type CadenceOnboarding = {
  total: number;
  totalIsCapped: boolean;
  open: number;
  openClient: number;
  openGbtn: number;
  byPriority: { day_1: number; week_1: number; week_2: number; unscheduled: number };
  top: { id: string; item: string; category: string; priorityLabel: string | null }[];
  more: number;
};

export type Cadence = {
  phaseCount: number;
  phasesComplete: number;
  allPhasesComplete: boolean;
  phasesFailed: boolean;
  current: CadencePhase | null;
  currentBasis: PhaseBasis | null;
  /** "Now" when today's window or status puts us in it; "Up next" on the sequence fallback. */
  currentLabel: "Now" | "Up next";
  next: CadencePhase | null;
  /** Null when the deliverables query failed. */
  deliverables: CadenceDeliverable[] | null;
  /** True when the list reaches back into an earlier phase that is still open. */
  deliverablesIncludeEarlier: boolean;
  /** Open deliverables in the current phase and earlier open phases — never later ones. */
  openDeliverableCount: number;
  moreDeliverables: number;
  /** Null when there are no linked rows or the query failed. */
  onboarding: CadenceOnboarding | null;
};

function phaseDateLabel(s: string | null, e: string | null, today: string): string | null {
  const tail = e !== null ? ` · through ${fmtDay(e)}` : " · ongoing";
  if (s !== null && s > today) return `Starts ${fmtDay(s)}${tail}`;
  if (s !== null && s === today) return `Starts today${tail}`;
  if (s === null && e === null) return null;
  if (e === null) return "Ongoing";
  return e >= today ? `Through ${fmtDay(e)}` : `Planned end ${fmtDay(e)}`;
}

function phaseStatus(status: string): { label: string | null; tone: StatusTone } {
  if (PHASE_ACTIVE.has(status)) return { label: "In progress", tone: "live" };
  if (PHASE_DONE.has(status)) return { label: "Complete", tone: "neutral" };
  if (PHASE_HOLD.has(status)) return { label: "On hold", tone: "paused" };
  return { label: null, tone: "neutral" }; // not_started and anything unmapped: no pill
}

function buildOnboarding(rows: OnboardingRow[], capped: boolean): CadenceOnboarding | null {
  if (rows.length === 0) return null;
  const open = rows.filter((r) => !ONBOARDING_DONE.has(r.status) && r.receivedOn === null);
  const byPriority = { day_1: 0, week_1: 0, week_2: 0, unscheduled: 0 };
  for (const r of open) {
    if (r.priority === "day_1" || r.priority === "week_1" || r.priority === "week_2") byPriority[r.priority]++;
    else byPriority.unscheduled++;
  }
  const rank = (p: string | null) => (p === null ? 4 : PRIORITY_RANK.get(p) ?? 3);
  const sorted = [...open].sort(
    (a, b) =>
      rank(a.priority) - rank(b.priority) ||
      (a.owner === b.owner ? 0 : a.owner === "client" ? -1 : 1) ||
      ascNullsLast(a.requestedOn, b.requestedOn) ||
      a.category.localeCompare(b.category, "en", { numeric: true }) ||
      a.item.localeCompare(b.item, "en", { numeric: true }) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const top = sorted.slice(0, 3).map((r) => ({
    id: r.id,
    item: r.item,
    category: r.category,
    priorityLabel: r.priority === null ? null : PRIORITY_LABEL.get(r.priority) ?? humanize(r.priority),
  }));
  const openGbtn = open.filter((r) => r.owner === "gbtn").length;
  return {
    total: rows.length,
    totalIsCapped: capped,
    open: open.length,
    openClient: open.length - openGbtn,
    openGbtn,
    byPriority,
    top,
    more: open.length - top.length,
  };
}

export function buildCadence(input: {
  phases: PhaseRow[];
  phasesFailed: boolean;
  deliverables: DeliverableRow[] | null;
  onboarding: OnboardingRow[] | null;
  onboardingCapped: boolean;
  today: string;
}): Cadence {
  const { today } = input;

  const phases = [...input.phases].sort(
    (a, b) =>
      a.sequence - b.sequence ||
      ascNullsLast(a.startsOn, b.startsOn) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const ordinalById = new Map(phases.map((p, i) => [p.id, i + 1] as const));
  const openPhases = phases.filter((p) => !PHASE_DONE.has(p.status));
  const openPhaseIds = new Set(openPhases.map((p) => p.id));

  // Current phase. Today's date window wins; then an in-progress status; then the
  // first open phase by sequence, which reads as "Up next" rather than "Now".
  const inWindow = (p: PhaseRow) =>
    p.startsOn !== null && p.startsOn <= today && (p.endsOn === null || today <= p.endsOn);
  let currentRow: PhaseRow | null = null;
  let basis: PhaseBasis | null = null;
  const byDates = openPhases.find(inWindow);
  const byStatus = openPhases.find((p) => PHASE_ACTIVE.has(p.status));
  if (byDates) {
    currentRow = byDates;
    basis = "dates";
  } else if (byStatus) {
    currentRow = byStatus;
    basis = "status";
  } else if (openPhases.length > 0) {
    currentRow = openPhases[0];
    basis = "sequence";
  }

  // Deliverables: per-phase counts, then the open work.
  const counts = new Map<string, { total: number; done: number }>();
  const openDeliverables: DeliverableRow[] = [];
  for (const d of input.deliverables ?? []) {
    const c = counts.get(d.phaseId) ?? { total: 0, done: 0 };
    const done = DELIVERABLE_DONE.has(d.status) || d.deliveredOn !== null;
    c.total++;
    if (done) c.done++;
    counts.set(d.phaseId, c);
    // Open work inside a completed phase is lagging status, not a to-do.
    if (!done && openPhaseIds.has(d.phaseId)) openDeliverables.push(d);
  }

  const toCadencePhase = (p: PhaseRow): CadencePhase => {
    const st = phaseStatus(p.status);
    const c = counts.get(p.id) ?? { total: 0, done: 0 };
    return {
      id: p.id,
      ordinal: ordinalById.get(p.id) ?? 0,
      name: p.name,
      purpose: p.purpose,
      statusLabel: st.label,
      statusTone: st.tone,
      dateLabel: phaseDateLabel(p.startsOn, p.endsOn, today),
      isOngoing: p.endsOn === null,
      deliverableTotal: c.total,
      deliverableDone: c.done,
    };
  };

  const current = currentRow ? toCadencePhase(currentRow) : null;
  const nextRow = current ? openPhases.find((p) => (ordinalById.get(p.id) ?? 0) > current.ordinal) ?? null : null;

  // The Now card lists work from the current phase and any earlier phase still
  // open. Later phases' deliverables belong to the Up next card's "planned"
  // count — listing them here double-counts them.
  const currentOrdinal = current?.ordinal ?? 0;
  const currentId = current?.id ?? null;
  const pool = openDeliverables.filter((d) => (ordinalById.get(d.phaseId) ?? 0) <= currentOrdinal);

  // Current phase first; then dated items by due date; undated items keep phase
  // then sequence order.
  pool.sort((a, b) => {
    const cur = (a.phaseId === currentId ? 0 : 1) - (b.phaseId === currentId ? 0 : 1);
    if (cur !== 0) return cur;
    const due = ascNullsLast(a.dueOn, b.dueOn);
    if (due !== 0) return due;
    const ord = (ordinalById.get(a.phaseId) ?? 0) - (ordinalById.get(b.phaseId) ?? 0);
    if (ord !== 0) return ord;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const listed: CadenceDeliverable[] = pool.slice(0, 3).map((d) => {
    const overdue = d.dueOn !== null && d.dueOn < today;
    return {
      id: d.id,
      name: d.name,
      phaseOrdinal: ordinalById.get(d.phaseId) ?? 0,
      inCurrentPhase: current !== null && d.phaseId === current.id,
      dueLabel:
        d.dueOn === null
          ? null
          : overdue
            ? `Overdue · ${fmtDay(d.dueOn)}`
            : d.dueOn === today
              ? "Due today"
              : `Due ${fmtDay(d.dueOn)}`,
      overdue,
    };
  });

  const phasesComplete = phases.length - openPhases.length;

  return {
    phaseCount: phases.length,
    phasesComplete,
    allPhasesComplete: phases.length > 0 && openPhases.length === 0,
    phasesFailed: input.phasesFailed,
    current,
    currentBasis: basis,
    currentLabel: basis === "sequence" ? "Up next" : "Now",
    next: nextRow ? toCadencePhase(nextRow) : null,
    deliverables: input.deliverables === null ? null : listed,
    deliverablesIncludeEarlier: current !== null && listed.some((d) => d.phaseOrdinal < current.ordinal),
    openDeliverableCount: pool.length,
    moreDeliverables: Math.max(0, pool.length - listed.length),
    onboarding: input.onboarding === null ? null : buildOnboarding(input.onboarding, input.onboardingCapped),
  };
}

// ── Loader result ────────────────────────────────────────────────────────────

export type LoaderStage = "phases" | "deliverables" | "onboarding";

export type PortalHomeEngagementReady = {
  state: "ready";
  engagement: PortalEngagement;
  otherOpenCount: number;
  hiddenDraftCount: number;
  rungColumnMissing: boolean;
  cadence: Cadence;
  failed: LoaderStage[];
};

export type PortalHomeEngagementNone = {
  state: "none";
  completedCount: number;
  hiddenDraftCount: number;
  schemaMissing: boolean;
};

export type PortalHomeEngagementUnavailable = { state: "unavailable"; code: string | null };

export type PortalHomeEngagement =
  | PortalHomeEngagementReady
  | PortalHomeEngagementNone
  | PortalHomeEngagementUnavailable;

export const EMPTY_HOME_ENGAGEMENT: PortalHomeEngagementNone = {
  state: "none",
  completedCount: 0,
  hiddenDraftCount: 0,
  schemaMissing: false,
};
