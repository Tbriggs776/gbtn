import type { ThreadRow } from "@/lib/ghl/types";
import { CHANNEL_LABEL, duration, stamp } from "@/lib/ghl/format";

/**
 * One thread, read top to bottom.
 *
 * A server component: it renders static content from data the page already
 * fetched, so shipping it to the browser would buy nothing. Contact details
 * are shown here in full — unlike the AI pass, which redacts them, this is the
 * client's own CRM data being shown back to the client's own staff.
 */
export function Transcript({ thread }: { thread: ThreadRow }) {
  return (
    <section className="rounded-xl border border-line bg-white">
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-bold tracking-tight text-ink">
            {thread.contactName ?? "Unknown contact"}
          </h2>
          <span className="text-[11.5px] text-muted-soft">
            {CHANNEL_LABEL[thread.channel]} · {thread.assignedUserName ?? "Unassigned"}
          </span>
        </div>
        <p className="mt-1 text-[12px] text-muted">
          {thread.inboundCount} in / {thread.outboundCount} out ·{" "}
          {thread.autoRepliedOnly ? (
            <span className="font-semibold text-crimson">
              only the automation replied — no person ever followed up
            </span>
          ) : thread.unanswered ? (
            <span className="font-semibold text-crimson">never answered by a person</span>
          ) : (
            <>first human reply after {duration(thread.responseSeconds)}</>
          )}
          {thread.firstInboundAt ? <> · lead arrived {stamp(thread.firstInboundAt)}</> : null}
        </p>
      </header>

      <ol className="max-h-[32rem] space-y-3 overflow-y-auto px-4 py-4">
        {thread.messages.map((m) => {
          const inbound = m.direction === "inbound";
          return (
            <li
              key={m.ghlId}
              className={`flex flex-col gap-1 ${inbound ? "items-start" : "items-end"}`}
            >
              <span className="font-label text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-soft">
                {inbound ? "Customer" : m.automated ? "Automation" : (m.userId ? "Rep" : "Outbound")}
                {m.dateAdded ? ` · ${stamp(m.dateAdded)}` : ""}
                {m.status && m.status !== "delivered" ? ` · ${m.status}` : ""}
              </span>
              <div
                className={`max-w-[52ch] whitespace-pre-wrap rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                  inbound
                    ? "bg-paper-soft text-ink"
                    : m.automated
                      ? "border border-dashed border-line bg-white text-muted"
                      : "bg-ink text-white"
                }`}
              >
                {m.body ?? <span className="italic opacity-70">(no text — call or attachment)</span>}
              </div>
            </li>
          );
        })}
        {thread.messages.length === 0 ? (
          <li className="text-[13px] text-muted-soft">No messages stored for this thread.</li>
        ) : null}
      </ol>
    </section>
  );
}
