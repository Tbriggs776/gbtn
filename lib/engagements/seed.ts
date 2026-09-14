import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OfferRung } from "@/lib/crm/types";

// Default phase/deliverable checklist per Advantage OS rung. Generic GBTN
// methodology only, never client data. It seeds ONLY an engagement with zero
// phases, so a hand-built checklist is never touched, and it writes the whole
// template or nothing.
//
// Seeded rows are client-visible at once (engagement_phases_select), so the copy
// is written for clients. No dates: a converted engagement has no start_date, and
// invented due dates would show clients "Overdue" pills nobody committed to.
//
// Concurrency without a transaction (supabase-js has none): phases go in as ONE
// statement with ON CONFLICT (engagement_id, sequence) DO NOTHING, in ascending
// sequence, against uq_engagement_phases_seq. Two concurrent seeds both contend
// for sequence 1; the loser inserts nothing and stops. A partial insert (someone
// added a phase in the gap) is rolled back. Both rely on every rung template
// using the same sequences, hence the fixed-length tuple types.

type TemplatePhase = {
  sequence: 1 | 2 | 3 | 4;
  name: string;
  purpose: string;
  deliverables: readonly [string, string, string];
};
type RungTemplate = readonly [TemplatePhase, TemplatePhase, TemplatePhase, TemplatePhase];

export const RUNG_CHECKLIST: Record<OfferRung, RungTemplate> = {
  diagnose: [
    {
      sequence: 1,
      name: "Kickoff and data access",
      purpose: "Agree scope and owners, and get read access to the books, bank and operating systems.",
      deliverables: ["Kickoff agenda and owner map", "Data request list", "System access confirmed"],
    },
    {
      sequence: 2,
      name: "Financial baseline",
      purpose: "Rebuild the last 12 to 24 months into a clean, comparable baseline.",
      deliverables: [
        "Normalized trailing-twelve-month P&L",
        "Margin bridge (price, volume, mix, cost)",
        "Cash conversion and working-capital snapshot",
      ],
    },
    {
      sequence: 3,
      name: "Operating diagnostic",
      purpose: "Find where margin and cash leak across pricing, labor, jobs and overhead.",
      deliverables: [
        "Unit economics by service line",
        "Labor and overhead benchmark",
        "Prioritized levers with sized impact",
      ],
    },
    {
      sequence: 4,
      name: "Readout and roadmap",
      purpose: "Walk leadership through the findings and agree what to install first.",
      deliverables: ["Diagnostic readout", "90-day install roadmap", "Decision on next steps"],
    },
  ],
  install: [
    {
      sequence: 1,
      name: "Close and reporting foundation",
      purpose: "Stand up a reliable monthly close so every number after it can be trusted.",
      deliverables: [
        "Chart of accounts cleanup",
        "Month-end close calendar and checklist",
        "First on-time monthly close package",
      ],
    },
    {
      sequence: 2,
      name: "Cash and margin tools",
      purpose: "Put forward-looking cash and margin views in the leadership team's hands.",
      deliverables: ["13-week cash forecast", "Job and service-line margin report", "Pricing guardrails"],
    },
    {
      sequence: 3,
      name: "KPI scorecard and cadence",
      purpose: "Agree the few numbers that run the business and the meetings that review them.",
      deliverables: [
        "KPI scorecard with definitions, owners and targets",
        "Weekly scorecard review",
        "Monthly operating review agenda",
      ],
    },
    {
      sequence: 4,
      name: "Adoption and handoff",
      purpose: "Make the tools stick with the team that will run them.",
      deliverables: [
        "Owner training on the scorecard and forecast",
        "Operating playbook",
        "Readiness review for the ongoing cadence",
      ],
    },
  ],
  institutionalize: [
    {
      sequence: 1,
      name: "Annual operating calendar",
      purpose: "Lock the year's close, review and planning dates so the rhythm runs without reminders.",
      deliverables: [
        "Annual operating calendar",
        "Close calendar for the year",
        "Owner and board reporting schedule",
      ],
    },
    {
      sequence: 2,
      name: "Monthly operating rhythm",
      purpose: "Run the monthly close, scorecard and operating review every month.",
      deliverables: [
        "Monthly close package",
        "Scorecard refresh with variance commentary",
        "Rolling 13-week cash forecast update",
      ],
    },
    {
      sequence: 3,
      name: "Quarterly review and reforecast",
      purpose: "Each quarter, reforecast, re-rank the levers and reset targets.",
      deliverables: ["Quarterly business review", "Reforecast", "Lever and target reset"],
    },
    {
      sequence: 4,
      name: "Annual plan",
      purpose: "Build next year's budget and targets from what this year proved.",
      deliverables: ["Annual budget", "Next-year KPI targets", "Year-in-review readout"],
    },
  ],
};

export type SeedOutcome =
  | { status: "seeded"; phases: number; deliverables: number }
  | { status: "skipped_existing" }
  | { status: "skipped_race" }
  | { status: "failed"; stage: "count" | "phases" | "deliverables"; code: string | null; rolledBack: boolean };

/** Stage, code and message only — never row data. */
function log(stage: string, code: string | null | undefined, message: string): void {
  console.error("[engagement-seed]", stage, code ?? "no-code", message);
}

/** Remove exactly the phases this call inserted (their deliverables cascade). */
async function removeInserted(db: SupabaseClient, engagementId: string, ids: string[]): Promise<boolean> {
  const { error } = await db.from("engagement_phases").delete().eq("engagement_id", engagementId).in("id", ids);
  if (error) log("rollback", error.code, error.message);
  return !error;
}

/**
 * Seed the rung's default checklist onto an engagement that has no phases.
 * Never throws. The caller's rung write stands regardless of the outcome.
 * `db` must be a client whose policies allow staff writes (the cookie RLS
 * client for a staff session), and the caller must already have asserted.
 */
export async function seedChecklistForRung(
  db: SupabaseClient,
  engagementId: string,
  rung: OfferRung
): Promise<SeedOutcome> {
  try {
    const template = RUNG_CHECKLIST[rung];

    // 1. Zero-phases guard.
    const { count, error: countErr } = await db
      .from("engagement_phases")
      .select("id", { count: "exact", head: true })
      .eq("engagement_id", engagementId);
    if (countErr) {
      log("count", countErr.code, countErr.message);
      return { status: "failed", stage: "count", code: countErr.code ?? null, rolledBack: true };
    }
    if ((count ?? 0) > 0) return { status: "skipped_existing" };

    // 2. Phases: one statement, DO NOTHING on (engagement_id, sequence). Returns only the rows it inserted.
    const { data: phases, error: phaseErr } = await db
      .from("engagement_phases")
      .upsert(
        template.map((p) => ({
          engagement_id: engagementId,
          sequence: p.sequence,
          name: p.name,
          purpose: p.purpose,
        })),
        { onConflict: "engagement_id,sequence", ignoreDuplicates: true }
      )
      .select("id, sequence");
    if (phaseErr) {
      log("phases", phaseErr.code, phaseErr.message);
      // A single statement: nothing was inserted.
      return { status: "failed", stage: "phases", code: phaseErr.code ?? null, rolledBack: true };
    }

    const inserted: { id: string; sequence: number }[] = [];
    for (const r of Array.isArray(phases) ? phases : []) {
      if (typeof r.id === "string" && typeof r.sequence === "number") inserted.push({ id: r.id, sequence: r.sequence });
    }
    if (inserted.length === 0) return { status: "skipped_race" };
    if (inserted.length !== template.length) {
      // Someone else wrote phases between the count and the insert. Take ours back
      // out rather than mix template phases into their checklist.
      const rolledBack = await removeInserted(
        db,
        engagementId,
        inserted.map((p) => p.id)
      );
      return rolledBack
        ? { status: "skipped_race" }
        : { status: "failed", stage: "phases", code: null, rolledBack: false };
    }

    // 3. Deliverables for the phases this call inserted, in one atomic multi-row insert.
    const idBySeq = new Map(inserted.map((p) => [p.sequence, p.id] as const));
    const rows = template.flatMap((p) => {
      const phaseId = idBySeq.get(p.sequence);
      return phaseId ? p.deliverables.map((name, i) => ({ phase_id: phaseId, sequence: i + 1, name })) : [];
    });
    const { data: dels, error: delErr } = await db.from("engagement_deliverables").insert(rows).select("id");
    if (delErr) {
      log("deliverables", delErr.code, delErr.message);
      // Without this, the zero-phases guard would block every retry.
      const rolledBack = await removeInserted(
        db,
        engagementId,
        inserted.map((p) => p.id)
      );
      return { status: "failed", stage: "deliverables", code: delErr.code ?? null, rolledBack };
    }

    return { status: "seeded", phases: inserted.length, deliverables: Array.isArray(dels) ? dels.length : 0 };
  } catch (e) {
    log("exception", null, e instanceof Error ? e.message : String(e));
    return { status: "failed", stage: "phases", code: null, rolledBack: false };
  }
}
