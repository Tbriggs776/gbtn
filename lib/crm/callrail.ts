import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readPlatformJson } from "@/lib/integrations/platform-secrets";
import { findContactByPhone } from "./service";
import { logInboundCall } from "./comms";

// CallRail → CRM sync: pull recent calls and attach them (by phone match) to the
// contact timeline. Credentials live in Vault under the "callrail" provider
// (JSON: { apiKey, accountId }). Service-role db from the cron.

type DB = SupabaseClient;

export type CallRailConfig = { apiKey: string; accountId: string };

export async function getCallRailConfig(): Promise<CallRailConfig | null> {
  const c = await readPlatformJson<CallRailConfig>("callrail");
  if (!c?.apiKey || !c?.accountId) return null;
  return c;
}

type CallRailCall = {
  id: string;
  customer_phone_number?: string;
  direction?: string;
  duration?: number;
  answered?: boolean;
  recording?: string | null;
  start_time?: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Sync CallRail calls from the last `sinceDays` into contact timelines. Only
 * calls that match an existing contact (by last-10 digits) are logged; each is
 * de-duplicated by its CallRail id. Returns counts.
 */
export async function syncCallRailCalls(
  db: DB,
  { sinceDays = 2 }: { sinceDays?: number } = {}
): Promise<{ fetched: number; logged: number; unmatched: number; skipped: number }> {
  const cfg = await getCallRailConfig();
  if (!cfg) throw new Error("CallRail is not configured.");

  const headers = { Authorization: `Token token="${cfg.apiKey}"`, Accept: "application/json" };
  const fields = ["customer_phone_number", "direction", "duration", "answered", "recording", "start_time"].join(",");
  const end = ymd(new Date());
  const startD = new Date();
  startD.setDate(startD.getDate() - sinceDays);
  const start = ymd(startD);
  const base = `https://api.callrail.com/v3/a/${cfg.accountId}/calls.json`;

  let page = 1;
  let totalPages = 1;
  let fetched = 0;
  let logged = 0;
  let unmatched = 0;
  let skipped = 0;

  do {
    const url = `${base}?start_date=${start}&end_date=${end}&per_page=250&page=${page}&fields=${encodeURIComponent(fields)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`CallRail ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { calls?: CallRailCall[]; total_pages?: number };
    totalPages = data.total_pages ?? 1;
    const calls = data.calls ?? [];
    fetched += calls.length;

    for (const call of calls) {
      const phone = call.customer_phone_number;
      if (!phone) {
        skipped++;
        continue;
      }
      const contact = await findContactByPhone(db, phone);
      if (!contact) {
        unmatched++;
        continue;
      }
      // Dedup by CallRail id.
      const { data: existing } = await db
        .from("crm_activities")
        .select("id")
        .eq("type", "call")
        .filter("meta->>sid", "eq", call.id)
        .limit(1)
        .maybeSingle();
      if (existing) {
        skipped++;
        continue;
      }
      await logInboundCall(db, {
        contactId: contact.id,
        from: phone,
        durationSec: call.duration,
        recordingUrl: call.recording ?? null,
        connected: Boolean(call.answered),
        provider: "callrail",
        sid: call.id,
        occurredAt: call.start_time,
      });
      logged++;
    }
    page++;
  } while (page <= totalPages);

  return { fetched, logged, unmatched, skipped };
}
