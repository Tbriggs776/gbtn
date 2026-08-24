import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrmConversationJoined, CrmMessage } from "./types";

// Read layer for the Conversations inbox. Client-injected like the rest of the
// CRM service (RLS server client for pages, service role for webhooks/cron).

type DB = SupabaseClient;

export type InboxFilter = { box?: "unread" | "mine" | "all"; channel?: "email" | "sms"; userId?: string };

export async function listConversations(
  db: DB,
  filter: InboxFilter = {}
): Promise<CrmConversationJoined[]> {
  let q = db
    .from("crm_conversations")
    .select(
      "*, contact:crm_contacts(id, first_name, last_name, email, phone, do_not_email, do_not_sms)"
    )
    .neq("status", "closed")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(200);

  if (filter.channel) q = q.eq("channel", filter.channel);
  if (filter.box === "unread") q = q.eq("unread", true);
  if (filter.box === "mine" && filter.userId) q = q.eq("assignee", filter.userId);
  const { data } = await q;
  return (data as CrmConversationJoined[]) ?? [];
}

export async function getConversation(
  db: DB,
  contactId: string,
  channel: "email" | "sms"
): Promise<CrmConversationJoined | null> {
  const { data } = await db
    .from("crm_conversations")
    .select(
      "*, contact:crm_contacts(id, first_name, last_name, email, phone, do_not_email, do_not_sms)"
    )
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .maybeSingle();
  return (data as CrmConversationJoined) ?? null;
}

/** The message stream for a thread (oldest first, for chat display). */
export async function getThreadMessages(
  db: DB,
  contactId: string,
  channel: "email" | "sms",
  limit = 200
): Promise<CrmMessage[]> {
  const { data } = await db
    .from("crm_messages")
    .select("*")
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .order("created_at", { ascending: true })
    .limit(limit);
  return (data as CrmMessage[]) ?? [];
}

export async function unreadCount(db: DB): Promise<number> {
  const { count } = await db
    .from("crm_conversations")
    .select("id", { count: "exact", head: true })
    .eq("unread", true)
    .neq("status", "closed");
  return count ?? 0;
}
