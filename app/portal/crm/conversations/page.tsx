import Link from "next/link";
import { getSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { ConversationThread } from "@/components/portal/crm/conversation-thread";
import { listConversations, getConversation, getThreadMessages } from "@/lib/crm/conversations";
import { contactName, type Channel } from "@/lib/crm/types";
import { relativeTime } from "@/lib/format";

type SP = { box?: "unread" | "mine" | "all"; channel?: Channel; c?: string; ch?: Channel };

export default async function ConversationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const box = sp.box ?? "all";
  const db = await createClient();
  const session = await getSession();

  const conversations = await listConversations(db, {
    box,
    channel: sp.channel,
    userId: session?.user.id,
  });

  // Selected thread (?c=contactId&ch=channel)
  const selectedChannel: Channel = sp.ch === "email" ? "email" : "sms";
  const selected = sp.c ? await getConversation(db, sp.c, selectedChannel) : null;
  const messages = selected ? await getThreadMessages(db, selected.contact_id, selectedChannel) : [];
  const c = selected?.contact;
  const canReply = selectedChannel === "sms" ? Boolean(c?.phone && !c?.do_not_sms) : Boolean(c?.email && !c?.do_not_email);
  const cantReason =
    selectedChannel === "sms"
      ? !c?.phone ? "No phone number on file." : "Contact is marked do-not-SMS."
      : !c?.email ? "No email address on file." : "Contact is marked do-not-email.";

  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (box !== "all") p.set("box", box);
    if (sp.channel) p.set("channel", sp.channel);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `/portal/crm/conversations?${p.toString()}`;
  };

  return (
    <PortalShell wide>
      <PortalHeader title="Conversations" subtitle="Unified SMS inbox — reply and triage across all contacts." />
      <CrmNav />

      <div className="mt-4 flex flex-wrap items-center gap-1">
        {(["all", "unread", "mine"] as const).map((b) => (
          <Link
            key={b}
            href={`/portal/crm/conversations?${new URLSearchParams({ ...(b !== "all" ? { box: b } : {}), ...(sp.channel ? { channel: sp.channel } : {}) }).toString()}`}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize ${
              box === b ? "bg-ink text-white" : "text-muted hover:bg-paper-soft"
            }`}
          >
            {b}
          </Link>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* Thread list */}
        <div className="overflow-hidden rounded-2xl border border-line bg-white ring-soft">
          {conversations.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-muted">No conversations{box === "unread" ? " unread" : ""}.</p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
              {conversations.map((cv) => {
                const active = selected?.id === cv.id;
                return (
                  <li key={cv.id}>
                    <Link
                      href={qs({ c: cv.contact_id, ch: cv.channel })}
                      className={`block px-4 py-3 ${active ? "bg-paper-soft" : "hover:bg-paper-soft/60"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`truncate text-sm ${cv.unread ? "font-bold text-ink" : "font-medium text-ink"}`}>
                          {cv.contact ? contactName(cv.contact) : "Unknown"}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {cv.unread ? <span className="h-2 w-2 rounded-full bg-brand-600" /> : null}
                          <span className="text-[10px] uppercase tracking-wide text-muted-soft">{cv.channel}</span>
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-soft">
                        {cv.last_message_at ? relativeTime(cv.last_message_at) : ""}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Thread pane */}
        <div className="rounded-2xl border border-line bg-white ring-soft">
          {selected && c ? (
            <ConversationThread
              contactId={selected.contact_id}
              channel={selectedChannel}
              contactName={contactName(c)}
              canReply={canReply}
              reason={cantReason}
              messages={messages}
            />
          ) : (
            <div className="grid h-[70vh] place-items-center text-center">
              <div>
                <p className="text-sm font-semibold text-ink">Select a conversation</p>
                <p className="mt-1 text-sm text-muted-soft">Pick a thread on the left to read and reply.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </PortalShell>
  );
}
