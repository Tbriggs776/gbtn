"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge } from "./ui";
import { setTaskStatus } from "@/lib/crm/actions";
import { relativeTime } from "@/lib/format";
import { contactName, type CrmTaskJoined } from "@/lib/crm/types";

export function TasksList({ tasks }: { tasks: CrmTaskJoined[] }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [filter, setFilter] = useState<"open" | "all">("open");

  function toggle(id: string, done: boolean) {
    start(async () => {
      await setTaskStatus(id, done ? "done" : "open");
      router.refresh();
    });
  }

  const shown = filter === "open" ? tasks.filter((t) => t.status === "open") : tasks;

  return (
    <div className="mt-6">
      <div className="mb-3 flex gap-1">
        {(["open", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              filter === f ? "bg-ink text-white" : "text-muted hover:bg-paper-soft"
            }`}
          >
            {f === "open" ? "Open" : "All"}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-12 text-center text-sm text-muted">
          No {filter === "open" ? "open " : ""}tasks.
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-white ring-soft">
          {shown.map((t) => {
            const overdue = t.status === "open" && t.due_at && new Date(t.due_at) < new Date();
            return (
              <li key={t.id} className="flex items-center gap-3 px-5 py-3.5">
                <input
                  type="checkbox"
                  checked={t.status === "done"}
                  onChange={(e) => toggle(t.id, e.target.checked)}
                  className="h-4 w-4"
                />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold ${t.status === "done" ? "text-muted-soft line-through" : "text-ink"}`}>
                    {t.title}
                  </p>
                  {t.contact ? (
                    <Link
                      href={`/portal/crm/contacts/${t.contact.id}`}
                      className="text-xs text-brand-700 hover:underline"
                    >
                      {contactName(t.contact)}
                    </Link>
                  ) : null}
                </div>
                {t.priority === "high" ? <Badge tone="red">high</Badge> : null}
                {t.due_at ? (
                  <span className={`shrink-0 text-xs ${overdue ? "font-semibold text-brand-700" : "text-muted-soft"}`}>
                    {relativeTime(t.due_at)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
