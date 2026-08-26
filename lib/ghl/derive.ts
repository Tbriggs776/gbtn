// Per-thread metrics, computed once at sync. Referenced by migration 0021.
//
// These live here rather than in SQL for one reason: they all depend on message
// ORDER within a thread, and doing that in Postgres means a window function over
// the whole message table every time a report loads. Computing at write time
// costs nothing (we already hold the thread in memory to insert it) and makes
// every downstream query a plain column read.
//
// What is NOT derived here: anything that depends on a policy we might change
// our mind about. Business-hours adjustment is the example — it needs Floor
// Daddy's opening hours, and baking those into a stored column would mean a
// full re-sync the day they open on Sundays. That one is applied at read time
// in metrics.ts, from a single constant.

import type { Channel, Conversation, Message } from "./types";

/** Thread metadata that doesn't come from the transcript. */
export type ThreadBase = {
  ghlId: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  dateAdded: string | null;
  lastMessageAt: string | null;
  /** The search index shows the customer reached in (see map.ts searchInbound). */
  inboundSeen: boolean;
};

/**
 * Fold a thread's messages into the row we store.
 *
 * Message-derived fields always win where they disagree with `base`: the search
 * index lags the transcript, and the transcript is what actually happened.
 */
export function deriveConversation(base: ThreadBase, messages: Message[]): Conversation {
  const ordered = [...messages].sort(byDate);

  let inbound = 0;
  let outbound = 0;
  let firstInboundAt: string | null = null;
  let firstResponseAt: string | null = null;
  let sawAutoReply = false;

  for (const m of ordered) {
    if (m.direction === "inbound") {
      inbound++;
      if (!firstInboundAt && m.dateAdded) firstInboundAt = m.dateAdded;
      continue;
    }

    outbound++;
    // Only an outbound that lands AFTER the lead spoke is a reply. An outbound
    // before it is the campaign that provoked the thread, and counting it would
    // produce a negative response time.
    const isReply = Boolean(firstInboundAt && m.dateAdded && m.dateAdded >= firstInboundAt);
    if (!isReply) continue;

    if (m.automated) {
      // The auto-responder fired. Noted, but it is not an answer: it tells the
      // lead nothing a person couldn't, and scoring it as one is exactly how a
      // dashboard ends up reporting a 9-second response time on a lead nobody
      // ever called back.
      sawAutoReply = true;
      continue;
    }
    if (!firstResponseAt) firstResponseAt = m.dateAdded;
  }

  const responseSeconds =
    firstInboundAt && firstResponseAt
      ? Math.max(0, Math.round((Date.parse(firstResponseAt) - Date.parse(firstInboundAt)) / 1000))
      : null;

  // Purely a transcript fact: no inbound MESSAGES, some outbound. Kept
  // independent of inboundSeen so the pass-3 recompute (which can't see the
  // search index) stays consistent. Whether a thread counts as a LEAD is decided
  // in metrics.ts leadThreads, which also honours inboundSeen — so a form/ad lead
  // we only auto-replied to is outbound-only by transcript yet still a lead.
  const outboundOnly = inbound === 0 && outbound > 0;
  // "Unanswered" means a person said something and no person came back. A
  // thread with no messages at all is neither answered nor unanswered.
  const unanswered = inbound > 0 && firstResponseAt === null;
  const autoRepliedOnly = unanswered && sawAutoReply;

  // The rep credited with the thread. GHL's assignedTo is frequently blank
  // (round-robin assigns on the opportunity, not the conversation), so fall
  // back to whoever actually did the replying — and only ever to a HUMAN send,
  // or every unattended thread would be credited to the automation's user.
  const assignedUserId = base.assignedUserId ?? lastHumanOutboundUser(ordered);

  const last = ordered.length > 0 ? ordered[ordered.length - 1].dateAdded : null;

  return {
    ghlId: base.ghlId,
    contactId: base.contactId,
    contactName: base.contactName,
    contactEmail: base.contactEmail,
    contactPhone: base.contactPhone,
    assignedUserId,
    assignedUserName: base.assignedUserName,
    channel: dominantChannel(ordered),
    dateAdded: base.dateAdded ?? (ordered.length > 0 ? ordered[0].dateAdded : null),
    lastMessageAt: last ?? base.lastMessageAt,
    messageCount: ordered.length,
    inboundCount: inbound,
    outboundCount: outbound,
    firstInboundAt,
    firstResponseAt,
    responseSeconds,
    unanswered,
    outboundOnly,
    autoRepliedOnly,
    inboundSeen: base.inboundSeen,
  };
}

/**
 * The thread's channel. A flooring lead often texts and then gets an emailed
 * quote, so threads are genuinely mixed; we label by the channel that carried
 * the most messages, breaking ties toward the channel the lead OPENED on —
 * that's the one that set their expectation for a reply.
 */
function dominantChannel(messages: Message[]): Channel {
  if (messages.length === 0) return "other";
  const tally = new Map<Channel, number>();
  for (const m of messages) tally.set(m.channel, (tally.get(m.channel) ?? 0) + 1);

  const opener = messages.find((m) => m.direction === "inbound")?.channel ?? messages[0].channel;

  let best: Channel = opener;
  let bestN = -1;
  for (const [ch, n] of tally) {
    if (n > bestN || (n === bestN && ch === opener)) {
      best = ch;
      bestN = n;
    }
  }
  return best;
}

/** Who sent the most recent human outbound message — our fallback thread owner. */
function lastHumanOutboundUser(ordered: Message[]): string | null {
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i];
    if (m.direction === "outbound" && !m.automated && m.userId) return m.userId;
  }
  return null;
}

function byDate(a: Message, b: Message): number {
  // Undated messages sort last: they can't anchor a response time, and putting
  // them first would let one break every thread it appears in.
  if (!a.dateAdded) return 1;
  if (!b.dateAdded) return -1;
  return a.dateAdded < b.dateAdded ? -1 : a.dateAdded > b.dateAdded ? 1 : 0;
}
