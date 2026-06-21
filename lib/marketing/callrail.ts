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

// Pull calls for a date range and aggregate by day. Uses the calls list
// endpoint (stable) and counts a "lead" as a call with lead_status 'good_lead'.
export type CallRailDay = { date: string; calls: number; leads: number };

export async function fetchCallRailDailyCalls(
  apiKey: string,
  accountId: string,
  startDate: string,
  endDate: string
): Promise<CallRailDay[]> {
  const byDay = new Map<string, { calls: number; leads: number }>();
  let page = 1;
  let totalPages = 1;

  do {
    const url = new URL(`${BASE}/a/${accountId}/calls.json`);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);
    url.searchParams.set("fields", "lead_status");
    url.searchParams.set("per_page", "250");
    url.searchParams.set("page", String(page));

    const res = await fetch(url.toString(), { headers: authHeader(apiKey), cache: "no-store" });
    if (!res.ok) throw new Error(`CallRail calls error ${res.status}`);
    const json = (await res.json()) as {
      calls?: Array<{ start_time?: string; lead_status?: string }>;
      total_pages?: number;
    };

    for (const c of json.calls ?? []) {
      const date = String(c.start_time ?? "").slice(0, 10);
      if (!date) continue;
      const e = byDay.get(date) ?? { calls: 0, leads: 0 };
      e.calls += 1;
      if (c.lead_status === "good_lead") e.leads += 1;
      byDay.set(date, e);
    }

    totalPages = json.total_pages ?? 1;
    page += 1;
  } while (page <= totalPages && page <= 20); // safety cap

  return [...byDay.entries()].map(([date, v]) => ({ date, calls: v.calls, leads: v.leads }));
}
