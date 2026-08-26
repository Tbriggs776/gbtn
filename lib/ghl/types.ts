// Domain types for the GoHighLevel conversation module.
//
// Split in two on purpose:
//   • Ghl*Api types mirror what the GHL REST API actually returns. They are
//     deliberately loose (almost everything optional) — GHL adds and renames
//     fields without versioning the payload, and a strict type here would turn
//     a harmless new field into a sync outage.
//   • The rest are OUR types, which the app can rely on.

export type Channel = "sms" | "email" | "call" | "chat" | "other";
export type Direction = "inbound" | "outbound";

// ── What GHL sends us ────────────────────────────────────────────────────────

export type GhlConversationApi = {
  id?: string;
  contactId?: string;
  locationId?: string;
  fullName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  assignedTo?: string;
  type?: string;
  lastMessageDate?: string | number;
  lastMessageType?: string;
  dateAdded?: string | number;
  dateUpdated?: string | number;
  unreadCount?: number;
  [k: string]: unknown;
};

export type GhlMessageApi = {
  id?: string;
  conversationId?: string;
  contactId?: string;
  /** GHL uses 1 = inbound, 2 = outbound on some payloads and a string on others. */
  direction?: string | number;
  messageType?: string;
  type?: string | number;
  body?: string;
  /** Email bodies come back on their own field on some message types. */
  html?: string;
  subject?: string;
  userId?: string;
  status?: string;
  dateAdded?: string | number;
  [k: string]: unknown;
};

export type GhlUserApi = {
  id?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  [k: string]: unknown;
};

// ── What we store ────────────────────────────────────────────────────────────

/** A message, normalised. */
export type Message = {
  ghlId: string;
  conversationId: string | null;
  contactId: string | null;
  direction: Direction;
  channel: Channel;
  messageType: string | null;
  body: string | null;
  userId: string | null;
  status: string | null;
  /** GHL's own origin field: workflow | bulk_actions | campaign | api | app. */
  source: string | null;
  /**
   * Sent by automation rather than by a person. Derived from `source` at sync —
   * this is the field that keeps an auto-responder from being scored as a rep
   * answering the phone. See map.ts.
   */
  automated: boolean;
  dateAdded: string | null; // ISO
};

/** A thread, normalised, with its derived metrics attached. */
export type Conversation = {
  ghlId: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  channel: Channel;
  dateAdded: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  firstInboundAt: string | null;
  /** First reply BY A PERSON. Automated sends are excluded — see derive.ts. */
  firstResponseAt: string | null;
  responseSeconds: number | null;
  unanswered: boolean;
  outboundOnly: boolean;
  /**
   * The customer reached IN, per the conversation search index — an inbound
   * last message or an unread inbound — even when the message export carried no
   * inbound message we could store. This is what lets a form/ad lead count as a
   * lead instead of being filed as "outbound only". See map.ts `searchInbound`.
   */
  inboundSeen: boolean;
  /**
   * An automation replied but no person ever did. These look answered in GHL's
   * inbox and are the single most useful thing this report surfaces.
   */
  autoRepliedOnly: boolean;
};

/**
 * A thread plus its transcript, on the way IN — built by the sync, not yet
 * written, so it has no database id yet.
 */
export type Thread = Conversation & { messages: Message[] };

/** Row shape the portal reads back out of Postgres. */
export type ConversationRow = Conversation & { id: string };

/**
 * A thread plus its transcript, on the way OUT.
 *
 * Distinct from Thread for the same reason ConversationRow is distinct from
 * Conversation: everything read back carries the row id that everything being
 * written does not. Collapsing the two would mean either inventing an id at
 * sync time or letting the drill-down reference one that might not exist.
 */
export type ThreadRow = ConversationRow & { messages: Message[] };

export type ConnectionRow = {
  clientId: string;
  locationId: string;
  displayName: string | null;
  hint: string | null;
  status: string;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  /** Oldest date the time-boxed backfill has reached; null = complete/not started. */
  backfillThrough: string | null;
};

export type SyncResult = {
  conversations: number;
  messages: number;
  /** Threads GHL listed that we could not read messages for — surfaced, never swallowed. */
  skipped: number;
  from: string;
  to: string;
  /** True once the whole window is synced; false if time-boxed and more remains. */
  complete: boolean;
  /** Oldest date reached this run (ISO) — the resume point when not complete. */
  oldestCovered: string;
};
