import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  buildCadence,
  EMPTY_HOME_ENGAGEMENT,
  parseDeliverableRows,
  parseEngagementRows,
  parseOnboardingRows,
  parsePhaseRows,
  selectPrimaryEngagement,
  toPortalEngagement,
  type DeliverableRow,
  type LoaderStage,
  type OnboardingRow,
  type PhaseRow,
  type PortalHomeEngagement,
} from "./portal-model";

// Loader for the engagement half of the client portal home.
//
// Reads through the cookie-bound RLS client with EXPLICIT client_id /
// engagement_id filters, and builds that client itself so no caller can hand it
// the service role. Moving this to createAdminClient() requires a
// requireCapability/assertCapability gate before the fetch.
//
// The explicit filters are the tenant boundary for platform admins, not
// decoration: is_member_of() short-circuits on is_admin(), and every
// *_staff_write FOR ALL policy grants SELECT on every client's rows.
//
// Never rejects. There is no error.tsx, so a throw here would blank the home;
// every failure degrades to a calm state the strip knows how to render.

const ENG_COLS_0029 = "id, client_id, name, engagement_type, status, start_date, initial_term_end, created_at";
// crm_deal_id is read only to derive the `fromDeal` boolean; it never leaves the parser.
const ENG_COLS_0030 = `${ENG_COLS_0029}, offer_rung, crm_deal_id`;
const PHASE_COLS = "id, engagement_id, sequence, name, purpose, starts_on, ends_on, status";
const DELIV_COLS = "id, phase_id, sequence, name, status, due_on, delivered_on";
const ONB_COLS = "id, client_id, engagement_id, category, item, priority, owner, status, requested_on, received_on";
// Never selected: fees, billing/notice terms, auto_renew, deliverable descriptions,
// onboarding notes. No crm_* table is read.

const ENGAGEMENT_LIMIT = 25;
const PHASE_LIMIT = 50;
const DELIVERABLE_LIMIT = 500;
const ONBOARDING_LIMIT = 500;

type DbError = { code: string | null; message: string };
type Settled = { data: unknown; error: DbError | null };

/** Await a query and turn both an error result and a throw into `{ data, error }`. */
async function settle(
  query: PromiseLike<{ data: unknown; error: { code: string; message: string } | null }>
): Promise<Settled> {
  try {
    const { data, error } = await query;
    return { data, error: error ? { code: error.code || null, message: error.message ?? "" } : null };
  } catch (e) {
    return { data: null, error: { code: null, message: e instanceof Error ? e.message : String(e) } };
  }
}

/** Stage, code and message only — never row data. */
function logFailure(stage: string, error: DbError): void {
  console.error("[portal-home]", stage, error.code ?? "no-code", error.message);
}

function isMissingTable(error: DbError): boolean {
  return error.code === "42P01" || error.code === "PGRST205";
}

function isMissingRungColumn(error: DbError): boolean {
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /offer_rung|crm_deal_id/i.test(error.message)
  );
}

export async function loadPortalHomeEngagement(
  /** Always activeClient.id — never the raw ?client= param. */
  clientId: string,
  opts: { today: string; viewerIsAdmin: boolean }
): Promise<PortalHomeEngagement> {
  try {
    const supabase = await createClient();

    const engagementsQuery = (cols: string) =>
      supabase
        .from("engagements")
        .select(cols)
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(ENGAGEMENT_LIMIT);

    // Q1 — engagements, tolerating an environment where 0030 isn't applied.
    let has0030 = true;
    let q1 = await settle(engagementsQuery(ENG_COLS_0030));
    if (q1.error && !isMissingTable(q1.error) && isMissingRungColumn(q1.error)) {
      logFailure("engagements:rung-columns-missing", q1.error);
      has0030 = false;
      q1 = await settle(engagementsQuery(ENG_COLS_0029));
    }
    if (q1.error) {
      logFailure("engagements", q1.error);
      if (isMissingTable(q1.error)) return { ...EMPTY_HOME_ENGAGEMENT, schemaMissing: true };
      return { state: "unavailable", code: q1.error.code };
    }

    const rows = parseEngagementRows(q1.data, clientId, has0030);
    const selection = selectPrimaryEngagement(rows, { today: opts.today });
    const primary = selection.primary;
    if (!primary) {
      return {
        state: "none",
        completedCount: selection.completedCount,
        hiddenDraftCount: selection.hiddenDraftCount,
        schemaMissing: false,
      };
    }

    const failed: LoaderStage[] = [];

    // Q2 phases and Q4 onboarding in parallel; each fails on its own.
    const [q2, q4] = await Promise.all([
      settle(
        supabase
          .from("engagement_phases")
          .select(PHASE_COLS)
          .eq("engagement_id", primary.id)
          .order("sequence", { ascending: true })
          .limit(PHASE_LIMIT)
      ),
      settle(
        supabase
          .from("onboarding_items")
          .select(ONB_COLS)
          .eq("client_id", clientId)
          .eq("engagement_id", primary.id)
          .limit(ONBOARDING_LIMIT)
      ),
    ]);

    let phases: PhaseRow[] = [];
    let phasesFailed = false;
    if (q2.error) {
      logFailure("phases", q2.error);
      phasesFailed = true;
      failed.push("phases");
    } else {
      phases = parsePhaseRows(q2.data, primary.id);
    }

    // Q3 deliverables, scoped to the phases we were allowed to read.
    let deliverables: DeliverableRow[] | null = [];
    if (phases.length > 0) {
      const phaseIds = phases.map((p) => p.id);
      const q3 = await settle(
        supabase
          .from("engagement_deliverables")
          .select(DELIV_COLS)
          .in("phase_id", phaseIds)
          .limit(DELIVERABLE_LIMIT)
      );
      if (q3.error) {
        logFailure("deliverables", q3.error);
        deliverables = null;
        failed.push("deliverables");
      } else {
        deliverables = parseDeliverableRows(q3.data, new Set(phaseIds));
      }
    }

    let onboarding: OnboardingRow[] | null = null;
    let onboardingCapped = false;
    if (q4.error) {
      logFailure("onboarding", q4.error);
      failed.push("onboarding");
    } else {
      onboarding = parseOnboardingRows(q4.data, clientId, primary.id);
      onboardingCapped = Array.isArray(q4.data) && q4.data.length >= ONBOARDING_LIMIT;
    }

    return {
      state: "ready",
      engagement: toPortalEngagement(primary, opts.today, { isAdmin: opts.viewerIsAdmin }),
      otherOpenCount: selection.otherOpenCount,
      hiddenDraftCount: selection.hiddenDraftCount,
      rungColumnMissing: !has0030,
      cadence: buildCadence({
        phases,
        phasesFailed,
        deliverables,
        onboarding,
        onboardingCapped,
        today: opts.today,
      }),
      failed,
    };
  } catch (e) {
    console.error("[portal-home]", "exception", e instanceof Error ? e.message : String(e));
    return { state: "unavailable", code: null };
  }
}
