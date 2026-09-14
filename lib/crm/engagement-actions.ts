"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertAdmin, assertStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { seedChecklistForRung, type SeedOutcome } from "@/lib/engagements/seed";
import { createEngagementForDeal, isOfferRung, type OfferRung } from "./engagements";
import type { ActionResult } from "./types";

// Staff-only: convert a CRM deal into a client engagement on the offer ladder.
// Uses the service role (createAdminClient) because provisioning a `clients`
// row has no INSERT RLS policy — writes go through the service role, behind
// this assertStaff() gate (same posture as lib/financials/qbo/provision.ts).
//
// When an admin converts, the rung's default checklist is seeded through the
// RLS client (engagement_phases_staff_write). Employees convert without it —
// they get no client-data write path — and an admin adds it later from the
// portal home ("Add checklist").

export async function createEngagementAction(input: {
  dealId: string;
  offerRung: OfferRung;
  clientId?: string;
  newClientName?: string;
  dealTitle?: string;
}): Promise<ActionResult<{ engagementId: string; seed: SeedOutcome | null }>> {
  try {
    const session = await assertStaff();
    if (!input.dealId) return { ok: false, error: "Missing deal." };
    const db = createAdminClient();
    const { id } = await createEngagementForDeal(db, input);
    const seed = session.isAdmin ? await seedChecklistForRung(await createClient(), id, input.offerRung) : null;
    revalidatePath("/portal/crm/deals");
    revalidatePath("/portal/crm");
    revalidatePath("/portal");
    return { ok: true, data: { engagementId: id, seed } };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE = "The rung changed since this page loaded. Refresh and try again.";

/** null = clear; undefined = invalid input. */
function parseRung(v: unknown): OfferRung | null | undefined {
  if (v === null || v === "") return null;
  return isOfferRung(v) ? v : undefined;
}

export type SetRungResult = { rung: OfferRung | null; seed: SeedOutcome | null };

/**
 * Admin-only: set, change or clear engagements.offer_rung on an EXISTING
 * engagement, from the portal home engagement strip.
 *
 * assertAdmin, not assertStaff: the portal home renders this control only for
 * platform admins and redirects employees, and an employee is "CRM only, no
 * client data". A server action is reachable by any signed-in session, so the
 * gate matches the narrowest intended caller rather than the UI.
 *
 * Writes ONLY offer_rung — never engagement_type, which portal-model treats as
 * the deal-convert marker. The cookie RLS client suffices
 * (engagements_staff_write); no service role.
 *
 * The default checklist is seeded when the rung goes from unset to set, or when
 * the admin explicitly asks ("Add checklist"). Changing between two set rungs
 * never seeds, and the seed itself only ever writes into an engagement with
 * zero phases.
 */
export async function setEngagementRungAction(input: {
  engagementId: string;
  /** activeClient.id the admin is looking at. Checked against the row, never trusted for scope. */
  clientId: string;
  rung: OfferRung | null;
  /** The rung the admin saw when the page rendered (optimistic concurrency). */
  expectedRung: OfferRung | null;
  /** Explicit "Add checklist" request. */
  seedChecklist?: boolean;
}): Promise<ActionResult<SetRungResult>> {
  try {
    await assertAdmin();

    const engagementId = typeof input?.engagementId === "string" ? input.engagementId : "";
    const clientId = typeof input?.clientId === "string" ? input.clientId : "";
    if (!UUID_RE.test(engagementId) || !UUID_RE.test(clientId)) {
      return { ok: false, error: "Missing engagement." };
    }
    const rung = parseRung(input.rung);
    const expected = parseRung(input.expectedRung);
    if (rung === undefined || expected === undefined) return { ok: false, error: "Pick a ladder rung." };

    const db = await createClient();

    // Existence and tenant check. The ROW's client_id is authoritative.
    const { data: row, error: readErr } = await db
      .from("engagements")
      .select("id, client_id, offer_rung")
      .eq("id", engagementId)
      .maybeSingle();
    if (readErr) {
      const missing = readErr.code === "42703" || /offer_rung/i.test(readErr.message);
      return {
        ok: false,
        error: missing ? "The offer_rung column is missing (0030)." : "Couldn't load the engagement.",
      };
    }
    if (!row || row.client_id !== clientId) {
      return { ok: false, error: "Engagement not found for this client. Refresh and try again." };
    }
    const current = parseRung(row.offer_rung) ?? null; // a bad stored value reads as unset
    if (current !== expected) return { ok: false, error: STALE };

    let saved: OfferRung | null = current;
    if (rung !== current) {
      let q = db.from("engagements").update({ offer_rung: rung }).eq("id", engagementId).eq("client_id", clientId);
      q = expected === null ? q.is("offer_rung", null) : q.eq("offer_rung", expected);
      const { data: upd, error: updErr } = await q.select("id, offer_rung").maybeSingle();
      if (updErr) {
        return {
          ok: false,
          error: updErr.code === "23514" ? "That isn't a valid rung." : "Couldn't save the rung.",
        };
      }
      // 0 rows = RLS denial (no error by design) or a concurrent edit. Never report success.
      if (!upd) return { ok: false, error: STALE };
      saved = parseRung(upd.offer_rung) ?? null;
    }

    const wantsSeed = saved !== null && (current === null || input.seedChecklist === true);
    const seed = saved !== null && wantsSeed ? await seedChecklistForRung(db, engagementId, saved) : null;

    revalidatePath("/portal");
    revalidatePath("/portal/crm/deals");
    revalidatePath("/portal/crm");
    return { ok: true, data: { rung: saved, seed } };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, error: e instanceof Error ? e.message : "Something went wrong." };
  }
}
