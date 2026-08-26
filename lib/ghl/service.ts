import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveConversation } from "./derive";
import type {
  ConnectionRow,
  Conversation,
  ConversationRow,
  Message,
  Thread,
  ThreadRow,
} from "./types";

// Service-role reads/writes for the GHL tables. Every caller must already have
// verified the caller's membership of the client (see actions.ts) — the service
// role bypasses RLS by design, exactly as lib/ops/service.ts does.

const CHUNK = 500;
const PAGE = 1000; // Supabase caps a select at 1000 rows

// ── Connection & token ───────────────────────────────────────────────────────

export async function getConnection(clientId: string): Promise<ConnectionRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ghl_connections")
    // secret_ref is deliberately absent: nothing above this line should ever
    // hold a handle to the token, even an opaque one.
    .select("client_id, location_id, display_name, hint, status, last_synced_at, last_sync_error, backfill_through")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    clientId: data.client_id as string,
    locationId: data.location_id as string,
    displayName: (data.display_name as string | null) ?? null,
    hint: (data.hint as string | null) ?? null,
    status: (data.status as string) ?? "pending",
    lastSyncedAt: (data.last_synced_at as string | null) ?? null,
    lastSyncError: (data.last_sync_error as string | null) ?? null,
    backfillThrough: (data.backfill_through as string | null) ?? null,
  };
}

/** Record the backfill resume point (oldest date reached), or null when done. */
export async function setBackfillThrough(clientId: string, through: Date | null): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("ghl_connections")
    .update({ backfill_through: through ? through.toISOString() : null, updated_at: new Date().toISOString() })
    .eq("client_id", clientId);
}

/** Clients with a live GHL connection — the nightly cron's work list. */
export async function listConnectedClientIds(): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ghl_connections")
    .select("client_id")
    .neq("status", "disconnected")
    .not("secret_ref", "is", null);
  if (error) throw new Error(`ghl_connections: ${error.message}`);
  return (data ?? []).map((r) => r.client_id as string);
}

export async function storeToken(
  clientId: string,
  locationId: string,
  token: string
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("store_ghl_token", {
    p_client_id: clientId,
    p_location_id: locationId,
    p_token: token,
    // Only the tail, so an admin can tell two tokens apart without the value
    // ever being recoverable from the table.
    p_hint: token.slice(-4),
  });
  if (error) throw new Error(error.message);
}

export async function readToken(clientId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("read_ghl_token", { p_client_id: clientId });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

export async function disconnect(clientId: string): Promise<void> {
  const admin = createAdminClient();
  // The Vault secret is left in place and simply orphaned — vault.delete_secret
  // isn't exposed to us here, and a disconnected row with status 'disconnected'
  // can never be used to authenticate anyway (readToken is only called after a
  // status check).
  const { error } = await admin
    .from("ghl_connections")
    .update({ status: "disconnected", updated_at: new Date().toISOString() })
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
}

export async function markSynced(clientId: string, errorMessage?: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("ghl_connections")
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_error: errorMessage ?? null,
      status: errorMessage ? "needs_reauth" : "connected",
      updated_at: new Date().toISOString(),
    })
    .eq("client_id", clientId);
}

// ── Writing a sync ───────────────────────────────────────────────────────────

/**
 * Upsert threads and their transcripts.
 *
 * Unlike the RFMS import (which deletes and reloads, because an RFMS export is
 * a full snapshot), a GHL sync is a WINDOW: it reads from `since` forward and
 * knows nothing about older threads. Deleting first would throw away every
 * conversation outside the window, so this upserts on the natural key instead.
 *
 * That window is also why this runs in three passes rather than one.
 *
 * The messages a sync holds are only those inside the window, so for any thread
 * older than the window they are the TAIL of a longer conversation, not the
 * whole of it. Deriving speed-to-lead from that tail and writing it over the
 * stored row is how a correct year-to-date figure silently rots: a January lead
 * answered in two minutes, poked once in August, would come back as
 * "outbound_only, never answered" and drop out of every metric — because
 * leadThreads() filters exactly on those columns. The nightly cron would
 * degrade the year a little more each run, and nothing would look broken.
 *
 * So: write identity first, write messages second, and only then recompute the
 * derived columns from EVERYTHING stored for that thread. ghl_messages is
 * append-only, so the third pass always sees the full history.
 */
export async function saveThreads(clientId: string, threads: Thread[]): Promise<number> {
  if (threads.length === 0) return 0;
  const admin = createAdminClient();
  const now = new Date().toISOString();

  // ── Pass 1: identity and metadata ──────────────────────────────────────
  //
  // No derived columns here — see above. Contact details are coalesced against
  // what's already stored rather than overwritten: /conversations/search only
  // returns threads whose dateAdded falls in range, so a long-running thread
  // legitimately has no metadata on an incremental run, and writing the null
  // would blank a customer's name that we already know.
  const existing = await existingMetadata(clientId, threads.map((t) => t.ghlId));

  const convRows = threads.map((t) => {
    const prior = existing.get(t.ghlId);
    return {
      client_id: clientId,
      ghl_id: t.ghlId,
      contact_id: t.contactId ?? prior?.contact_id ?? null,
      contact_name: t.contactName ?? prior?.contact_name ?? null,
      contact_email: t.contactEmail ?? prior?.contact_email ?? null,
      contact_phone: t.contactPhone ?? prior?.contact_phone ?? null,
      assigned_user_id: t.assignedUserId ?? prior?.assigned_user_id ?? null,
      assigned_user_name: t.assignedUserName ?? prior?.assigned_user_name ?? null,
      date_added: t.dateAdded ?? prior?.date_added ?? null,
      synced_at: now,
    };
  });

  const idByGhlId = new Map<string, string>();
  for (let i = 0; i < convRows.length; i += CHUNK) {
    const { data, error } = await admin
      .from("ghl_conversations")
      .upsert(convRows.slice(i, i + CHUNK), { onConflict: "client_id,ghl_id" })
      .select("id, ghl_id");
    if (error) throw new Error(`ghl_conversations: ${error.message}`);
    for (const r of data ?? []) idByGhlId.set(r.ghl_id as string, r.id as string);
  }

  // ── Pass 2: the transcript ─────────────────────────────────────────────
  const msgRows = threads.flatMap((t) => {
    const convId = idByGhlId.get(t.ghlId);
    if (!convId) return [];
    return t.messages.map((m) => ({
      client_id: clientId,
      conversation_id: convId,
      ghl_id: m.ghlId,
      ghl_contact_id: m.contactId,
      direction: m.direction,
      channel: m.channel,
      message_type: m.messageType,
      body: m.body,
      user_id: m.userId,
      status: m.status,
      source: m.source,
      automated: m.automated,
      date_added: m.dateAdded,
    }));
  });

  for (let i = 0; i < msgRows.length; i += CHUNK) {
    const { error } = await admin
      .from("ghl_messages")
      .upsert(msgRows.slice(i, i + CHUNK), { onConflict: "client_id,ghl_id" });
    if (error) throw new Error(`ghl_messages: ${error.message}`);
  }

  // ── Pass 3: recompute the derived columns from the full stored history ──
  await recomputeAggregates(clientId, [...idByGhlId.values()]);

  return convRows.length;
}

type PriorMetadata = {
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  date_added: string | null;
};

/** What we already know about these threads, so a sync never blanks a field. */
async function existingMetadata(
  clientId: string,
  ghlIds: string[]
): Promise<Map<string, PriorMetadata>> {
  const out = new Map<string, PriorMetadata>();
  if (ghlIds.length === 0) return out;
  const admin = createAdminClient();

  for (let i = 0; i < ghlIds.length; i += 100) {
    const { data, error } = await admin
      .from("ghl_conversations")
      .select(
        "ghl_id, contact_id, contact_name, contact_email, contact_phone, assigned_user_id, assigned_user_name, date_added"
      )
      .eq("client_id", clientId)
      .in("ghl_id", ghlIds.slice(i, i + 100));
    if (error) throw new Error(`ghl_conversations: ${error.message}`);
    for (const r of data ?? []) {
      out.set(r.ghl_id as string, {
        contact_id: (r.contact_id as string | null) ?? null,
        contact_name: (r.contact_name as string | null) ?? null,
        contact_email: (r.contact_email as string | null) ?? null,
        contact_phone: (r.contact_phone as string | null) ?? null,
        assigned_user_id: (r.assigned_user_id as string | null) ?? null,
        assigned_user_name: (r.assigned_user_name as string | null) ?? null,
        date_added: (r.date_added as string | null) ?? null,
      });
    }
  }
  return out;
}

/**
 * Recompute every derived column for these threads from the complete set of
 * messages stored against them.
 *
 * Runs deriveConversation — the same function the sync uses — rather than a
 * second implementation in SQL, so there is exactly one definition of what
 * "answered" means. The base metadata handed in is a stub: only the aggregate
 * fields of the result are written back.
 */
export async function recomputeAggregates(
  clientId: string,
  conversationIds: string[]
): Promise<void> {
  if (conversationIds.length === 0) return;
  const admin = createAdminClient();
  const transcripts = await getTranscripts(clientId, conversationIds);

  const updates = conversationIds.map((id) => {
    const messages = transcripts.get(id) ?? [];
    const d = deriveConversation(STUB_BASE, messages);
    return {
      id,
      client_id: clientId,
      channel: d.channel,
      last_message_at: d.lastMessageAt,
      message_count: d.messageCount,
      inbound_count: d.inboundCount,
      outbound_count: d.outboundCount,
      first_inbound_at: d.firstInboundAt,
      first_response_at: d.firstResponseAt,
      response_seconds: d.responseSeconds,
      unanswered: d.unanswered,
      outbound_only: d.outboundOnly,
      auto_replied_only: d.autoRepliedOnly,
    };
  });

  // Every id here came back from pass 1, so each is strictly an UPDATE of the
  // aggregate columns. It must NOT be an upsert: upsert builds an INSERT tuple,
  // and Postgres validates that tuple's constraints before the ON CONFLICT
  // redirect — with ghl_id omitted (NOT NULL, no default) the insert path trips
  // the not-null constraint even though the row would only ever update. Update
  // in place instead (id is the primary key).
  for (const u of updates) {
    const { id, ...fields } = u;
    const { error } = await admin
      .from("ghl_conversations")
      .update(fields)
      .eq("id", id);
    if (error) throw new Error(`ghl_conversations aggregates: ${error.message}`);
  }
}

const STUB_BASE = {
  ghlId: "",
  contactId: null,
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  assignedUserId: null,
  assignedUserName: null,
  dateAdded: null,
  lastMessageAt: null,
};

// ── Reading ──────────────────────────────────────────────────────────────────

/** The most recent conversation activity we hold for a client, or null. */
export async function latestActivity(clientId: string): Promise<Date | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ghl_conversations")
    .select("last_message_at")
    .eq("client_id", clientId)
    .not("last_message_at", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const v = data?.last_message_at as string | null | undefined;
  return v ? new Date(v) : null;
}

/**
 * The reporting window: the WINDOW_DAYS ending at the latest activity we hold,
 * not at wall-clock now. Anchoring to the data means the report always shows the
 * most recent 90 days of real conversations even when the server clock runs
 * ahead of the account's activity (nothing to show otherwise). Falls back to a
 * now-anchored window when there's no data yet.
 */
export const REPORT_WINDOW_DAYS = 30;

export async function reportWindow(clientId: string): Promise<{ from: Date; to: Date }> {
  const latest = await latestActivity(clientId);
  const to = latest ?? new Date();
  const from = new Date(to.getTime() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

/**
 * Every thread whose last message falls in [from, to]. Paged explicitly:
 * Supabase caps a select at 1000 rows and a year of a busy location is well
 * past that.
 */
export async function listConversations(
  clientId: string,
  from: string,
  to: string
): Promise<ConversationRow[]> {
  const admin = createAdminClient();
  const out: ConversationRow[] = [];

  for (let page = 0; ; page++) {
    const { data, error } = await admin
      .from("ghl_conversations")
      .select("*")
      .eq("client_id", clientId)
      .gte("last_message_at", from)
      .lte("last_message_at", to)
      .order("last_message_at", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`ghl_conversations: ${error.message}`);
    const batch = data ?? [];
    out.push(...batch.map(toConversationRow));
    if (batch.length < PAGE) break;
  }
  return out;
}

/** One thread with its transcript, for the drill-down. */
export async function getThread(
  clientId: string,
  conversationId: string
): Promise<ThreadRow | null> {
  const admin = createAdminClient();
  const { data: conv, error } = await admin
    .from("ghl_conversations")
    .select("*")
    .eq("client_id", clientId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !conv) return null;

  const { data: msgs } = await admin
    .from("ghl_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("date_added", { ascending: true })
    .limit(PAGE);

  return { ...toConversationRow(conv), messages: (msgs ?? []).map(toMessage) };
}

/** Transcripts for a set of threads — what the coaching pass reads. */
export async function getTranscripts(
  clientId: string,
  conversationIds: string[]
): Promise<Map<string, Message[]>> {
  const byConv = new Map<string, Message[]>();
  if (conversationIds.length === 0) return byConv;
  const admin = createAdminClient();

  for (let i = 0; i < conversationIds.length; i += 100) {
    const { data, error } = await admin
      .from("ghl_messages")
      .select("*")
      .eq("client_id", clientId)
      .in("conversation_id", conversationIds.slice(i, i + 100))
      .order("date_added", { ascending: true });
    if (error) throw new Error(`ghl_messages: ${error.message}`);
    for (const row of data ?? []) {
      const key = row.conversation_id as string;
      const list = byConv.get(key) ?? [];
      list.push(toMessage(row));
      byConv.set(key, list);
    }
  }
  return byConv;
}

// ── Coaching notes ───────────────────────────────────────────────────────────

export type CoachingNote = {
  scope: "team" | "rep";
  repKey: string | null;
  content: string;
  model: string | null;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
};

export async function saveNote(
  clientId: string,
  note: Omit<CoachingNote, "generatedAt">,
  generatedBy: string | null
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("ghl_coaching_notes").insert({
    client_id: clientId,
    scope: note.scope,
    rep_key: note.repKey,
    content: note.content,
    model: note.model,
    period_start: note.periodStart,
    period_end: note.periodEnd,
    generated_by: generatedBy,
  });
  if (error) throw new Error(`ghl_coaching_notes: ${error.message}`);
}

/**
 * The newest note per scope+rep. One query, de-duped in memory: the alternative
 * is a DISTINCT ON view, and the table is small enough (a handful of notes per
 * generation) that it isn't worth the migration.
 */
export async function latestNotes(clientId: string): Promise<CoachingNote[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ghl_coaching_notes")
    .select("*")
    .eq("client_id", clientId)
    .order("generated_at", { ascending: false })
    .limit(200);
  if (error) return [];

  const seen = new Set<string>();
  const out: CoachingNote[] = [];
  for (const r of data ?? []) {
    const key = `${r.scope}:${r.rep_key ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      scope: r.scope as "team" | "rep",
      repKey: (r.rep_key as string | null) ?? null,
      content: r.content as string,
      model: (r.model as string | null) ?? null,
      periodStart: r.period_start as string,
      periodEnd: r.period_end as string,
      generatedAt: r.generated_at as string,
    });
  }
  return out;
}

// ── Row mapping ──────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function toConversationRow(r: Row): ConversationRow {
  return {
    id: r.id as string,
    ghlId: r.ghl_id as string,
    contactId: (r.contact_id as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? null,
    contactEmail: (r.contact_email as string | null) ?? null,
    contactPhone: (r.contact_phone as string | null) ?? null,
    assignedUserId: (r.assigned_user_id as string | null) ?? null,
    assignedUserName: (r.assigned_user_name as string | null) ?? null,
    channel: r.channel as Conversation["channel"],
    dateAdded: (r.date_added as string | null) ?? null,
    lastMessageAt: (r.last_message_at as string | null) ?? null,
    messageCount: Number(r.message_count ?? 0),
    inboundCount: Number(r.inbound_count ?? 0),
    outboundCount: Number(r.outbound_count ?? 0),
    firstInboundAt: (r.first_inbound_at as string | null) ?? null,
    firstResponseAt: (r.first_response_at as string | null) ?? null,
    responseSeconds:
      r.response_seconds === null || r.response_seconds === undefined
        ? null
        : Number(r.response_seconds),
    unanswered: Boolean(r.unanswered),
    outboundOnly: Boolean(r.outbound_only),
    autoRepliedOnly: Boolean(r.auto_replied_only),
  };
}

function toMessage(r: Row): Message {
  return {
    ghlId: r.ghl_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    contactId: (r.ghl_contact_id as string | null) ?? null,
    direction: r.direction as Message["direction"],
    channel: r.channel as Message["channel"],
    messageType: (r.message_type as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    automated: Boolean(r.automated),
    dateAdded: (r.date_added as string | null) ?? null,
  };
}
