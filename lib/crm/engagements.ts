import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  engagementBucket,
  isDraftEngagementStatus,
  normalizeStatus,
  toOfferRung,
} from "@/lib/engagements/portal-model";
import { OFFER_RUNGS, RUNG_LABEL, type OfferRung } from "./types";

export type { OfferRung };

// Advantage OS intake glue: read the engagement linked to a CRM deal, and
// convert a deal into a client engagement on the offer ladder. Follows the
// lib/crm convention of taking an injected `db` so both the action path (RLS,
// staff) and any future service-role caller can drive it.
//
// Client-row creation lives here too, mirroring lib/financials/qbo/provision.ts's
// slug loop rather than calling it — that factory needs a QBO realm + tokens.
// Because `public.clients` has no INSERT RLS policy (writes go through the
// service role, per 0029), the ACTION passes a service-role client.

export function isOfferRung(v: unknown): v is OfferRung {
  return typeof v === "string" && (OFFER_RUNGS as readonly string[]).includes(v);
}

export type DealEngagement = {
  id: string;
  name: string;
  offer_rung: OfferRung | null;
  client_id: string;
};

/** Engagements linked to these deals, keyed by crm_deal_id. */
export async function getEngagementsByDeal(
  db: SupabaseClient,
  dealIds: string[]
): Promise<Map<string, DealEngagement>> {
  const out = new Map<string, DealEngagement>();
  if (dealIds.length === 0) return out;
  const { data, error } = await db
    .from("engagements")
    .select("id, name, offer_rung, client_id, crm_deal_id")
    .in("crm_deal_id", dealIds);
  if (error) throw new Error(`engagements: ${error.message}`);
  for (const r of data ?? []) {
    const dealId = r.crm_deal_id as string | null;
    if (!dealId) continue;
    out.set(dealId, {
      id: r.id as string,
      name: r.name as string,
      offer_rung: (r.offer_rung as OfferRung | null) ?? null,
      client_id: r.client_id as string,
    });
  }
  return out;
}

/** Clients an engagement can be linked to, for the convert picker. */
export async function listLinkableClients(
  db: SupabaseClient
): Promise<{ id: string; name: string }[]> {
  const { data, error } = await db.from("clients").select("id, name").order("name");
  if (error) throw new Error(`clients: ${error.message}`);
  return (data ?? []).map((c) => ({ id: c.id as string, name: c.name as string }));
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "client"
  );
}

/** Create a client row from a name — same unique-slug loop as provision.ts. */
async function provisionClientFromName(db: SupabaseClient, name: string): Promise<string> {
  const base = name.trim() || "New client";
  let slug = slugify(base);
  for (let i = 1; ; i++) {
    const { data: clash } = await db
      .from("clients")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!clash) break;
    slug = `${slugify(base)}-${i}`;
  }
  // 'prospect' until kickoff, mirroring provision.ts's QBO-sourced leads — a deal
  // that just converted isn't an active client engagement until work starts.
  const { data, error } = await db
    .from("clients")
    .insert({ name: base, slug, status: "prospect", source: "manual" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create client: ${error?.message}`);
  return data.id as string;
}

export type CreateEngagementInput = {
  dealId: string;
  offerRung: OfferRung;
  /** Link to this existing client, OR pass newClientName to provision one. */
  clientId?: string;
  newClientName?: string;
  /** Deal title, used to name the engagement. */
  dealTitle?: string;
};

/**
 * Convert a CRM deal into a client engagement on the ladder. Provisions the
 * client if a new name is given; otherwise links the chosen client. Guarded
 * against a duplicate engagement on the same deal (the unique index enforces it
 * too, but this returns a clean message first).
 */
export async function createEngagementForDeal(
  db: SupabaseClient,
  input: CreateEngagementInput
): Promise<{ id: string; clientId: string }> {
  if (!isOfferRung(input.offerRung)) throw new Error("Pick a ladder rung.");

  const { data: existing } = await db
    .from("engagements")
    .select("id")
    .eq("crm_deal_id", input.dealId)
    .maybeSingle();
  if (existing) throw new Error("This deal already has an engagement.");

  let clientId = input.clientId?.trim() || "";
  if (!clientId) {
    if (!input.newClientName?.trim()) {
      throw new Error("Pick an existing client or enter a new client name.");
    }
    clientId = await provisionClientFromName(db, input.newClientName);
  }

  const name = (input.dealTitle?.trim() || `${RUNG_LABEL[input.offerRung]} engagement`).slice(
    0,
    200
  );
  const { data, error } = await db
    .from("engagements")
    .insert({
      client_id: clientId,
      crm_deal_id: input.dealId,
      offer_rung: input.offerRung,
      engagement_type: input.offerRung,
      name,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create engagement: ${error?.message}`);
  return { id: data.id as string, clientId };
}

export type EngagementRungCounts = Record<OfferRung | "unset", number> & { total: number };

/**
 * Open engagements by ladder rung, for the CRM home. Uses the same vocabulary as
 * the portal home: terminal statuses and drafts are skipped. Selects offer_rung
 * and status only — no names, fees or client ids. Null on any error (including
 * a missing 0030 column); never throws, since there is no error.tsx.
 */
export async function getOpenEngagementRungCounts(db: SupabaseClient): Promise<EngagementRungCounts | null> {
  const { data, error } = await db.from("engagements").select("offer_rung, status").limit(1000);
  if (error) {
    console.error("[crm-home]", "engagement-rungs", error.code ?? "no-code", error.message);
    return null;
  }
  const out: EngagementRungCounts = { diagnose: 0, install: 0, institutionalize: 0, unset: 0, total: 0 };
  for (const r of Array.isArray(data) ? data : []) {
    const status = normalizeStatus(r.status);
    if (engagementBucket(status) === "terminal" || isDraftEngagementStatus(status)) continue;
    out[toOfferRung(r.offer_rung) ?? "unset"]++;
    out.total++;
  }
  return out;
}
