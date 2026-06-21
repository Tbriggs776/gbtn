import "server-only";

// Minimal CallRail API v3 client. Auth is a header API key:
//   Authorization: Token token="<api_key>"
// Docs: https://apidocs.callrail.com/

const BASE = "https://api.callrail.com/v3";

function authHeader(apiKey: string) {
  return { Authorization: `Token token="${apiKey}"` };
}

export type CallRailAccount = { id: string; name: string };

// Validate an API key by listing accounts. Returns the first account so we can
// label the connection. Used before we store the key.
export async function verifyCallRail(
  apiKey: string
): Promise<{ ok: boolean; account?: CallRailAccount; error?: string }> {
  try {
    const res = await fetch(`${BASE}/a.json`, {
      headers: authHeader(apiKey),
      cache: "no-store",
    });
    if (res.status === 401)
      return { ok: false, error: "CallRail rejected that API key. Double-check it and try again." };
    if (!res.ok) return { ok: false, error: `CallRail returned an error (${res.status}).` };
    const json = (await res.json()) as { accounts?: Array<{ id: string | number; name: string }> };
    const acct = json.accounts?.[0];
    if (!acct) return { ok: false, error: "That key has no CallRail accounts attached." };
    return { ok: true, account: { id: String(acct.id), name: acct.name } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't reach CallRail." };
  }
}

// Pull daily call counts for a date range, grouped by day. Used by the sync job
// (next increment). Returns rows shaped for marketing_metrics_daily.
export type CallRailDay = { date: string; calls: number; leads: number };

export async function fetchCallRailDailyCalls(
  apiKey: string,
  accountId: string,
  startDate: string,
  endDate: string
): Promise<CallRailDay[]> {
  // CallRail timeseries: calls grouped by day over a date range.
  const url = new URL(`${BASE}/a/${accountId}/calls/timeseries.json`);
  url.searchParams.set("group_by", "day");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  url.searchParams.set("fields", "calls_count,leads_count");

  const res = await fetch(url.toString(), { headers: authHeader(apiKey), cache: "no-store" });
  if (!res.ok) throw new Error(`CallRail timeseries error ${res.status}`);
  const json = (await res.json()) as {
    timeseries?: Array<{ date: string; calls_count?: number; leads_count?: number }>;
  };
  return (json.timeseries ?? []).map((r) => ({
    date: r.date,
    calls: r.calls_count ?? 0,
    leads: r.leads_count ?? 0,
  }));
}
