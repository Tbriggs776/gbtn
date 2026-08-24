"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button, ErrorText, TextArea } from "./ui";
import {
  replyToConversation,
  markConversationRead,
  setConversationStatus,
} from "@/lib/crm/conversation-actions";
import type { Channel, CrmMessage } from "@/lib/crm/types";
import { relativeTime } from "@/lib/format";

export function ConversationThread({
  contactId,
  channel,
  contactName,
  canReply,
  reason,
  messages,
}: {
  contactId: string;
  channel: Channel;
  contactName: string;
  canReply: boolean;
  reason?: string;
  messages: CrmMessage[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // Opening a thread clears its unread flag.
  useEffect(() => {
    markConversationRead(contactId, channel).then(() => router.refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, channel]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  function send() {
    if (!body.trim()) return;
    setError("");
    start(async () => {
      const res = await replyToConversation({ contact_id: contactId, channel, body });
      if (!res.ok) return setError(res.error);
      setBody("");
      router.refresh();
    });
  }

  function close() {
    start(async () => {
      await setConversationStatus(contactId, channel, "closed");
      router.push("/portal/crm/conversations");
      router.refresh();
    });
  }

  return (
    <div className="flex h-[70vh] flex-col">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div>
          <Link href={`/portal/crm/contacts/${contactId}`} className="text-sm font-bold text-ink hover:text-brand-700">
            {contactName}
          </Link>
          <span className="ml-2 text-xs uppercase tracking-wide text-muted-soft">{channel}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={close} disabled={pending}>
          Mark done
        </Button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto bg-paper-soft/40 px-5 py-4">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No messages yet.</p>
        ) : (
          messages.map((m) => {
            const out = m.direction === "outbound";
            return (
              <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${
                    out ? "bg-ink text-white" : "border border-line bg-white text-ink"
                  }`}
                >
                  {m.subject && channel === "email" ? (
                    <p className={`mb-1 text-xs font-semibold ${out ? "text-white/80" : "text-muted"}`}>{m.subject}</p>
                  ) : null}
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className={`mt-1 text-[10px] ${out ? "text-white/60" : "text-muted-soft"}`}>
                    {relativeTime(m.created_at)}
                    {out && m.status ? ` · ${m.status}` : ""}
                  </p>
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t border-line p-3">
        {canReply ? (
          <div className="flex items-end gap-2">
            <TextArea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`Reply by ${channel}…`}
              className="min-h-[46px]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
            />
            <Button onClick={send} disabled={pending || !body.trim()}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        ) : (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
            {reason ?? "Can't reply on this channel."}
          </p>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
