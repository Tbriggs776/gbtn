import "server-only";
import { exportMessages, listConversations, listUsers } from "./client";
import {
  bodyOf,
  channelOf,
  directionOf,
  isActivity,
  isAutomated,
  searchInbound,
  toIso,
  userName,
} from "./map";
import { deriveConversation, type ThreadBase } from "./derive";
import {
  getConnection,
  listBackfillPendingClientIds,
  listConnectedClientIds,
  markSynced,
  readToken,
  saveThreads,
  setBackfillThrough,
} from "./service";
import type { GhlConversationApi, GhlMessageApi, Message, SyncResult, Thread } from "./types";

// Pull a window of GoHighLevel conversations into our tables.
//
// Three reads, then one fold:
//   1. /users/                        who the reps are (once)
//   2. /conversations/messages/export every message in the window, by channel
//   3. /conversations/search          contact names + assignment per thread
// then the messages are grouped by conversationId and folded into threads.
//
// Rebuilding threads from the message stream rather than fetching each
// transcript individually is what keeps this affordable: step 2 is a few
// hundred requests for a year, where per-thread fetches would be thousands.

/** Threads per database write — bounds peak memory on a large backfill. */
const WRITE_BATCH = 200;

/** Per-run wall-clock budget. Stays safely under the 300s serverless limit so a
 *  busy account degrades into a resumable partial run instead of a 504. */
const SYNC_BUDGET_MS = 230_000;

/** Number of days in the default reporting/sync window. */
export const WINDOW_DAYS = 90;

/** Start of the rolling reporting window (last WINDOW_DAYS), in UTC. A full-year
 * backfill was too heavy to pull on demand; 90 days covers current performance. */
export function windowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Sync one client.
 *
 * `since` defaults to the last 90 days. The sync is idempotent — every
 * write upserts on the natural key — so re-running a window is safe and is how
 * you repair a partial run.
 */
export async function syncClient(
  clientId: string,
  opts: { since?: Date; backfill?: boolean; deadline?: number } = {}
): Promise<SyncResult> {
  const conn = await getConnection(clientId);
  if (!conn) throw new Error("GoHighLevel isn't connected for this client.");
  if (conn.status === "disconnected") {
    throw new Error("The GoHighLevel connection was disconnected. Reconnect it in Admin.");
  }

  const token = await readToken(clientId);
  if (!token) throw new Error("No GoHighLevel token stored for this client.");

  const ctx = { token, locationId: conn.locationId };
  const since = opts.since ?? windowStart();
  const until = new Date();

  // Time-box the run so a busy account degrades into a resumable partial sync
  // instead of a 504. The export walks newest-first, so a run that stops at the
  // deadline has covered the most recent days; we persist how far back it got
  // and the next click picks up from there. A sweep over several clients passes
  // one shared deadline so their budgets add up to a single invocation, not one
  // full budget each.
  const deadline = opts.deadline ?? Date.now() + SYNC_BUDGET_MS;

  // On a backfill, resume from where the last run stopped (backfillThrough).
  // The export still walks down from that point toward `since`. A fresh sync,
  // or one whose cursor is already past the window, walks from `until`.
  const resume =
    opts.backfill && conn.backfillThrough ? new Date(conn.backfillThrough) : null;
  const walkEnd = resume && resume.getTime() > since.getTime() ? resume : until;

  try {
    // Resolve reps once, for name lookup only. NON-FATAL: /users/ needs the
    // users.readonly scope, which a token scoped only to conversations lacks —
    // and a 401/403 here must NOT abort the whole sync, or the messages (the
    // actual data) never get pulled. Rep names simply degrade to null. This was
    // the bug that left the DB near-empty: listUsers threw first and killed
    // every run before a single message was exported.
    const nameById = new Map<string, string>();
    try {
      for (const u of await listUsers(ctx)) {
        if (typeof u.id === "string") nameById.set(u.id, userName(u));
      }
    } catch {
      // no rep directory; assignedUserName falls back to null below
    }

    // Thread metadata: contact name/phone/email, assignment, and the inbound
    // signal for form/ad leads (searchInbound). Fetched BEFORE the export on
    // purpose — the export can consume the whole time budget on a busy backfill,
    // and if this ran after it, the lead metadata (and the form/ad leads that
    // exist ONLY here) would be starved on exactly the runs that need it most.
    // NON-FATAL: on error, names fall back to the transcript and no metric breaks.
    const meta = new Map<string, GhlConversationApi>();
    try {
      for (const c of await listConversations(ctx, since, deadline)) {
        if (typeof c.id === "string") meta.set(c.id, c);
      }
    } catch {
      // no thread metadata; baseFor derives what it can from the messages
    }

    let savedConversations = 0;
    let savedMessages = 0;
    let batch: Thread[] = [];

    // Commit the search-based leads FIRST, before the export. A form/ad/call-in
    // lead shows up only in the search index (searchInbound), often with no
    // pullable message at all. Saving those now — as message-less lead rows —
    // means they're counted even if the export later eats the whole time budget
    // and the run is killed before its own save (which is exactly what happened
    // on a busy account, leaving inbound_seen at zero). A thread that DOES have a
    // transcript gets its messages added by the export pass below; every write is
    // an idempotent upsert. Only searchInbound records are saved here, so
    // outbound-only blast targets stay excluded.
    for (const [conversationId, c] of meta) {
      if (!searchInbound(c)) continue;
      const conversation = deriveConversation(baseFor(conversationId, c, []), []);
      batch.push({
        ...conversation,
        assignedUserName: conversation.assignedUserId
          ? (nameById.get(conversation.assignedUserId) ?? null)
          : null,
        messages: [],
      });
      if (batch.length >= WRITE_BATCH) {
        savedConversations += await saveThreads(clientId, batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      savedConversations += await saveThreads(clientId, batch);
      batch = [];
    }

    const { messages: rawMessages, oldestCovered } = await exportMessages(
      ctx,
      since,
      walkEnd,
      deadline
    );

    // Normalise, dropping CRM bookkeeping and anything we can't place in a
    // thread. `skipped` is reported rather than swallowed — a sync that
    // quietly discarded half the location would otherwise look like a success.
    let skipped = 0;
    const byConversation = new Map<string, Message[]>();

    for (const raw of rawMessages) {
      const m = normalise(raw);
      if (!m) {
        skipped++;
        continue;
      }
      if (isActivity(m.messageType)) continue; // expected noise, not a failure
      if (!m.conversationId) {
        skipped++;
        continue;
      }
      const list = byConversation.get(m.conversationId) ?? [];
      list.push(m);
      byConversation.set(m.conversationId, list);
    }

    for (const [conversationId, messages] of byConversation) {
      const base = baseFor(conversationId, meta.get(conversationId), messages);
      const conversation = deriveConversation(base, messages);

      batch.push({
        ...conversation,
        // deriveConversation may have back-filled the owner from the transcript,
        // so resolve the name from whatever it settled on.
        assignedUserName: conversation.assignedUserId
          ? (nameById.get(conversation.assignedUserId) ?? null)
          : null,
        messages,
      });

      if (batch.length >= WRITE_BATCH) {
        savedConversations += await saveThreads(clientId, batch);
        savedMessages += batch.reduce((n, t) => n + t.messages.length, 0);
        batch = [];
      }
    }

    if (batch.length > 0) {
      savedConversations += await saveThreads(clientId, batch);
      savedMessages += batch.reduce((n, t) => n + t.messages.length, 0);
    }

    // Did this run reach the far edge of the window? oldestCovered is where the
    // export stopped — either `since` (done) or the deadline cutoff (more left).
    const complete = oldestCovered.getTime() <= since.getTime();

    // Persist the resume point only for a backfill: clear it when complete so the
    // next click starts fresh at `until`, otherwise record how far back we got.
    if (opts.backfill) {
      await setBackfillThrough(clientId, complete ? null : oldestCovered);
    }

    await markSynced(clientId);

    return {
      conversations: savedConversations,
      messages: savedMessages,
      skipped,
      from: since.toISOString(),
      to: until.toISOString(),
      complete,
      oldestCovered: oldestCovered.toISOString(),
    };
  } catch (e) {
    // Record why, so the portal can say "needs reauth" instead of silently
    // showing yesterday's numbers forever.
    const message = e instanceof Error ? e.message : "GoHighLevel sync failed.";
    await markSynced(clientId, message);
    throw e;
  }
}

/**
 * Nightly sync for every connected client.
 *
 * Reads the rolling 90-day window. GHL can backdate a message (a call logged
 * late, a delayed email receipt), so re-reading only "since yesterday" would
 * miss it. Runs in backfill mode: each night is time-boxed and resumes from the
 * prior run's cursor, so a busy account whose 90 days can't be pulled in one
 * invocation finishes it across successive nights unattended — the same resume
 * machinery the manual Sync button and the every-10-min sweep drive.
 *
 * One client's failure never stops the others — the error is recorded on that
 * client's connection and the loop continues.
 */
export async function syncAllClients(): Promise<{
  synced: number;
  failed: number;
  results: { clientId: string; ok: boolean; detail: string }[];
}> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  const clientIds = await listConnectedClientIds();
  const results: { clientId: string; ok: boolean; detail: string }[] = [];
  let synced = 0;
  let failed = 0;

  for (const clientId of clientIds) {
    try {
      const r = await syncClient(clientId, { since, backfill: true });
      synced++;
      results.push({
        clientId,
        ok: true,
        detail: `${r.conversations} conversations, ${r.messages} messages${
          r.complete ? "" : ` (backfill to ${r.oldestCovered.slice(0, 10)}, more remaining)`
        }`,
      });
    } catch (e) {
      failed++;
      results.push({
        clientId,
        ok: false,
        detail: e instanceof Error ? e.message : "sync failed",
      });
    }
  }

  return { synced, failed, results };
}

/** Wall-clock budget for one sweep invocation, shared across every client it
 *  touches. Under the route's 300s limit with headroom for the final write. */
const SWEEP_BUDGET_MS = 270_000;

/**
 * High-frequency backfill sweep (every-10-min cron).
 *
 * Drives the resumable backfill to completion without anyone clicking Sync: it
 * only picks up clients whose window isn't built yet (see
 * listBackfillPendingClientIds) and shares ONE deadline across them, so several
 * clients advance within a single invocation instead of each taking a full
 * budget. When every client's window is complete the work list is empty and the
 * sweep is a no-op — it goes idle on its own, and the nightly full sync takes
 * over maintenance. `done` reports whether nothing was left to do.
 */
export async function runBackfillSweep(): Promise<{
  processed: number;
  done: boolean;
  results: { clientId: string; ok: boolean; detail: string }[];
}> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const deadline = Date.now() + SWEEP_BUDGET_MS;

  const clientIds = await listBackfillPendingClientIds();
  const results: { clientId: string; ok: boolean; detail: string }[] = [];

  for (const clientId of clientIds) {
    // Stop before the invocation is killed; the clients we didn't reach stay on
    // the pending list and the next tick (10 min later) picks them up.
    if (Date.now() >= deadline) break;
    try {
      const r = await syncClient(clientId, { since, backfill: true, deadline });
      results.push({
        clientId,
        ok: true,
        detail: r.complete
          ? `complete (${r.conversations} conversations)`
          : `backfilled to ${r.oldestCovered.slice(0, 10)}, more remaining`,
      });
    } catch (e) {
      results.push({
        clientId,
        ok: false,
        detail: e instanceof Error ? e.message : "sync failed",
      });
    }
  }

  // `done` is meaningful only when we worked the whole list: an empty list means
  // nothing is pending (fully idle). If we stopped at the deadline, more remains.
  const done = clientIds.length === 0;
  return { processed: results.length, done, results };
}

/** One export row → our Message, or null if it can't be used. */
function normalise(m: GhlMessageApi): Message | null {
  const id = str(m.id);
  if (!id) return null;

  // messageType is the string form ("TYPE_SMS"); `type` is GHL's numeric code
  // for the same thing and is useless as a label, so it is not a fallback here.
  const messageType = str(m.messageType);
  const source = str(m.source);

  return {
    ghlId: id,
    conversationId: str(m.conversationId),
    contactId: str(m.contactId),
    direction: directionOf(m.direction),
    channel: channelOf(messageType),
    messageType,
    body: bodyOf(m),
    userId: str(m.userId),
    status: str(m.status),
    source,
    automated: isAutomated(source),
    dateAdded: toIso(m.dateAdded as string | number | undefined),
  };
}

/**
 * Thread metadata, preferring the conversation record and falling back to the
 * transcript. The fallback matters: /conversations/search only returns threads
 * it still indexes, so a thread whose messages we have but whose record we
 * don't must still produce a usable row rather than vanish.
 */
function baseFor(
  conversationId: string,
  c: GhlConversationApi | undefined,
  messages: Message[]
): ThreadBase {
  return {
    ghlId: conversationId,
    contactId: str(c?.contactId) ?? messages.find((m) => m.contactId)?.contactId ?? null,
    contactName: str(c?.fullName) ?? str(c?.contactName),
    contactEmail: str(c?.email),
    contactPhone: str(c?.phone),
    assignedUserId: str(c?.assignedTo),
    assignedUserName: null, // resolved by the caller once the owner is settled
    dateAdded: toIso(c?.dateAdded as string | number | undefined),
    lastMessageAt: toIso(c?.lastMessageDate as string | number | undefined),
    // From the search record only — a form/ad lead reaches in without a message
    // we can pull. When there's no search record (transcript-only thread), the
    // inbound messages themselves establish the lead, so false is safe here.
    inboundSeen: c ? searchInbound(c) : false,
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
