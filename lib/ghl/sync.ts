import "server-only";
import { exportMessages, listConversations, listUsers } from "./client";
import { bodyOf, channelOf, directionOf, isActivity, isAutomated, toIso, userName } from "./map";
import { deriveConversation, type ThreadBase } from "./derive";
import { getConnection, listConnectedClientIds, markSynced, readToken, saveThreads } from "./service";
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
  opts: { since?: Date } = {}
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

  try {
    // Resolve reps once. A message only carries an opaque userId, and looking
    // it up per message would be thousands of redundant calls.
    const users = await listUsers(ctx);
    const nameById = new Map<string, string>();
    for (const u of users) {
      if (typeof u.id === "string") nameById.set(u.id, userName(u));
    }

    const rawMessages = await exportMessages(ctx, since, until);

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

    // Thread metadata: contact name/phone/email and assignment, which the
    // message stream doesn't carry.
    const meta = new Map<string, GhlConversationApi>();
    for (const c of await listConversations(ctx, since)) {
      if (typeof c.id === "string") meta.set(c.id, c);
    }

    let savedConversations = 0;
    let savedMessages = 0;
    let batch: Thread[] = [];

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

    await markSynced(clientId);

    return {
      conversations: savedConversations,
      messages: savedMessages,
      skipped,
      from: since.toISOString(),
      to: until.toISOString(),
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
 * Reads a rolling 14-day window rather than the full year: GHL can backdate a
 * message (a call logged late, a delayed email receipt), so re-reading only
 * "since yesterday" would miss it, while re-reading the year every night is
 * hundreds of needless requests. Two weeks covers the realistic lag.
 *
 * One client's failure never stops the others — the error is recorded on that
 * client's connection and the loop continues.
 */
export async function syncAllClients(): Promise<{
  synced: number;
  failed: number;
  results: { clientId: string; ok: boolean; detail: string }[];
}> {
  const NIGHTLY_DAYS = 14;
  const since = new Date(Date.now() - NIGHTLY_DAYS * 86_400_000);

  const clientIds = await listConnectedClientIds();
  const results: { clientId: string; ok: boolean; detail: string }[] = [];
  let synced = 0;
  let failed = 0;

  for (const clientId of clientIds) {
    try {
      const r = await syncClient(clientId, { since });
      synced++;
      results.push({
        clientId,
        ok: true,
        detail: `${r.conversations} conversations, ${r.messages} messages`,
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
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
