import "server-only";
import type { GhlConversationApi, GhlMessageApi, GhlUserApi } from "./types";

// Thin, read-only client for the GoHighLevel v2 REST API.
//
// Auth is a Private Integration Token (Settings → Private Integrations in the
// GHL sub-account), NOT the old v1 "API key". Per docs/oauth/Scopes.md it needs
// exactly three read scopes and nothing else:
//     conversations.readonly           GET /conversations/search
//     conversations/message.readonly   the message endpoints
//     users.readonly                   GET /users/
// This module never calls a write endpoint, so a token limited to those is
// sufficient — and a broader one still can't change anything through this code.
//
// GHL versions the API through a header rather than the path, and different
// resources are pinned to different dates. Sending the wrong one returns a 404
// that reads like a missing record, so the version travels with each call.

const BASE = "https://services.leadconnectorhq.com";
const V_CONVERSATIONS = "2021-04-15";
const V_USERS = "2021-07-28";

const PAGE = 100;

/** Stop conditions, so a pathological account can never spin forever. */
const MAX_PAGES = 500;

export class GhlError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "GhlError";
  }
}

export type Ctx = { token: string; locationId: string };

/**
 * The two passes that together cover every message type.
 *
 * `undefined` means send no `channel` filter at all. Per the endpoint's own
 * docs that returns "all non-email message types … including activity messages
 * (opportunity updates, appointments, etc.)" — everything except email, plus
 * noise we already know how to drop (isActivity in map.ts).
 *
 * The obvious-looking alternative — naming each channel — is WRONG, and was the
 * first version of this file. The `channel` enum only admits
 * Call|SMS|Email|WhatsApp|Instagram|Facebook, so there is no value that selects
 * web chat, live chat, Google Business Profile, RCS or TikTok. Enumerating
 * channels silently drops those conversations entirely, and — worse — drops
 * only the REPLY half of a mixed thread, so a lead answered in web chat two
 * minutes later gets filed as "never answered". The unfiltered pass is the only
 * way to reach them.
 */
const EXPORT_PASSES = [undefined, "Email"] as const;

async function get<T>(
  ctx: Ctx,
  path: string,
  params: Record<string, string | number | undefined>,
  version: string
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  // GHL's published burst limit is 100 requests per 10s per location
  // (docs/oauth/Authorization.md). The sync is sequential and nowhere near
  // that, so one retry is enough to ride out a shared-quota blip without
  // turning a genuine outage into a long hang.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Version: version,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt === 0) {
      // GHL publishes the window on the response; prefer it over guessing.
      const interval = Number(res.headers.get("x-ratelimit-interval-milliseconds"));
      const after = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(after) && after > 0
        ? after * 1000
        : Number.isFinite(interval) && interval > 0
          ? interval
          : 2000;
      await sleep(Math.min(waitMs, 15_000));
      continue;
    }

    // Translate the ones an admin can act on; everything else keeps its status.
    const detail = await res.text().catch(() => "");
    const message =
      res.status === 401
        ? "GoHighLevel rejected the token (401). Re-create the Private Integration token."
        : res.status === 403
          ? "The token is missing a required scope (403). It needs conversations.readonly, conversations/message.readonly, and users.readonly."
          : res.status === 404
            ? `GoHighLevel returned 404 for ${path} — check the Location ID.`
            : res.status === 429
              ? "GoHighLevel rate-limited the sync (429). Try again in a minute."
              : `GoHighLevel error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
    throw new GhlError(message, res.status);
  }
  throw new GhlError("GoHighLevel request failed after a retry.", 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Every message in the window, across every channel.
 *
 * This is the whole reason the sync is cheap. The obvious design — list threads,
 * then fetch each thread's transcript — costs one request per thread, so a year
 * of a busy location is thousands of calls. The export endpoint streams messages
 * for the entire location behind a cursor, which turns that into a few hundred:
 * a message carries its own conversationId, so the threads can be rebuilt from
 * the message stream alone.
 *
 * Walked once per channel, because `channel` is a filter rather than a list.
 */
export async function exportMessages(
  ctx: Ctx,
  since: Date,
  until: Date,
  onPage?: (n: number) => void
): Promise<GhlMessageApi[]> {
  const out: GhlMessageApi[] = [];
  // The unfiltered pass and the Email pass are documented as disjoint, but
  // de-duplicating by id costs one Set and removes any dependence on that
  // promise holding.
  const seen = new Set<string>();

  for (const channel of EXPORT_PASSES) {
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await get<{
        messages?: GhlMessageApi[];
        nextCursor?: string | null;
        total?: number;
      }>(
        ctx,
        "/conversations/messages/export",
        {
          locationId: ctx.locationId,
          channel,
          // The export requires ISO 8601 dates (unlike /conversations/search,
          // which wants Unix ms — the two endpoints disagree). Sending ms here
          // returns a 400 CONVERSATIONS_MSG_INVALID_START_DATE_FORMAT.
          startDate: since.toISOString(),
          endDate: until.toISOString(),
          limit: PAGE,
          sortBy: "createdAt",
          // Newest-first. The export caps its total result set, so ascending
          // order returns the OLDEST messages and truncates before reaching the
          // recent ones. Walk from the newest and stop once we cross `since`.
          sortOrder: "desc",
          cursor,
        },
        V_CONVERSATIONS
      );

      const batch = data.messages ?? [];
      for (const m of batch) {
        const id = typeof m.id === "string" ? m.id : null;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        out.push(m);
      }
      onPage?.(batch.length);

      // Descending walk: the last item of each page is its oldest. Once that
      // predates the window, everything further back is older too — stop this
      // pass. This bounds the pull even if the server ignores the date filter.
      const oldest = batch[batch.length - 1] as { dateAdded?: string } | undefined;
      const oldestMs = oldest?.dateAdded ? Date.parse(oldest.dateAdded) : NaN;
      if (Number.isFinite(oldestMs) && oldestMs < since.getTime()) break;

      // nextCursor is documented as null when the walk is done. Guard against a
      // server that repeats the cursor instead — that would loop forever.
      const next = data.nextCursor ?? undefined;
      if (!next || next === cursor || batch.length === 0) break;
      cursor = next;
    }
  }

  return out;
}

/**
 * Thread-level records, for the parts the message stream doesn't carry: the
 * contact's name, email and phone, and who the thread is assigned to.
 *
 * Paged with the `startAfterDate` cursor rather than an offset. GHL's search is
 * a live index — new messages reorder it mid-walk — so an offset-based page 7
 * can skip threads that shifted. A cursor anchored to the sort key can't.
 *
 * Deliberately does NOT send startDate/endDate. The spec defines both as a
 * "filter for dateAdded field" — when the THREAD was created — while the sort
 * and the cursor here run on last_message_date. Passing the sync window to them
 * therefore excludes exactly the threads that matter most: a job opened in
 * March and still live in August has a March dateAdded, so a 14-day nightly
 * window would omit it, its metadata would come back empty, and the sync would
 * blank a real customer's name. The startAfterDate cursor already bounds the
 * walk on the right field.
 *
 * Note: the published ConversationSchema for this endpoint doesn't document
 * lastMessageDate even though ConversationDto (the single-conversation shape)
 * does, and the cursor depends on it. If it ever really is absent the loop
 * stops early rather than spinning, and the thread metadata degrades to what
 * the message stream provides — names go missing, no metric is wrong.
 */
export async function listConversations(
  ctx: Ctx,
  since: Date
): Promise<GhlConversationApi[]> {
  const out: GhlConversationApi[] = [];
  const seen = new Set<string>();
  let cursor = since.getTime();

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await get<{ conversations?: GhlConversationApi[]; total?: number }>(
      ctx,
      "/conversations/search",
      {
        locationId: ctx.locationId,
        limit: PAGE,
        startAfterDate: cursor,
        sortBy: "last_message_date",
        sort: "asc",
        status: "all",
      },
      V_CONVERSATIONS
    );

    const batch = data.conversations ?? [];
    if (batch.length === 0) break;

    let advanced = false;
    for (const c of batch) {
      const id = typeof c.id === "string" ? c.id : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(c);
      const ts = epoch(c.lastMessageDate);
      // Threads sharing a timestamp are why we de-dupe by id: the cursor has to
      // move to the last one seen, which re-serves that whole tie on the next
      // page. Without the seen-set they'd be inserted twice.
      if (ts !== null && ts >= cursor) {
        cursor = ts;
        advanced = true;
      }
    }

    if (batch.length < PAGE) break;
    // Nothing on this page carried a usable timestamp, so the cursor can't move
    // and the next request would return the same page forever.
    if (!advanced) break;
  }

  return out;
}

/** Location users, so an opaque userId on a message can become a rep's name. */
export async function listUsers(ctx: Ctx): Promise<GhlUserApi[]> {
  const data = await get<{ users?: GhlUserApi[] }>(
    ctx,
    "/users/",
    { locationId: ctx.locationId },
    V_USERS
  );
  return data.users ?? [];
}

/** Cheap authenticated call, for the admin's "Test connection" button. */
export async function ping(ctx: Ctx): Promise<{ users: number }> {
  const users = await listUsers(ctx);
  return { users: users.length };
}

function epoch(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const ms = typeof v === "number" ? v : new Date(String(v)).getTime();
  return Number.isNaN(ms) ? null : ms;
}
