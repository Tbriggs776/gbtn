"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, ErrorText, Field, Modal, Select, TextArea, TextInput } from "./ui";
import { closeCase, createCase } from "@/lib/crm/actions";
import { relativeTime } from "@/lib/format";
import { contactName, type CrmCaseJoined, type CrmContactWithCompany } from "@/lib/crm/types";

export function CasesList({
  cases,
  contacts,
}: {
  cases: CrmCaseJoined[];
  contacts: CrmContactWithCompany[];
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [showNew, setShowNew] = useState(false);

  function close(id: string) {
    start(async () => {
      await closeCase(id);
      router.refresh();
    });
  }

  const shown = filter === "open" ? cases.filter((c) => c.status !== "closed") : cases;

  return (
    <div className="mt-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
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
        <Button className="ml-auto" onClick={() => setShowNew(true)}>
          + New case
        </Button>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-12 text-center text-sm text-muted">
          No {filter === "open" ? "open " : ""}cases.
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-white ring-soft">
          {shown.map((c) => {
            const overdue = c.status !== "closed" && c.due_at && new Date(c.due_at) < new Date();
            return (
              <li key={c.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold ${c.status === "closed" ? "text-muted-soft line-through" : "text-ink"}`}>
                    {c.title}
                  </p>
                  {c.contact ? (
                    <Link
                      href={`/portal/crm/contacts/${c.contact.id}`}
                      className="text-xs text-brand-700 hover:underline"
                    >
                      {contactName(c.contact)}
                    </Link>
                  ) : null}
                </div>
                <Badge tone={c.status === "closed" ? "green" : c.status === "pending" ? "amber" : "blue"}>
                  {c.status}
                </Badge>
                {c.priority === "high" ? <Badge tone="red">high</Badge> : null}
                {c.due_at ? (
                  <span className={`shrink-0 text-xs ${overdue ? "font-semibold text-brand-700" : "text-muted-soft"}`}>
                    {relativeTime(c.due_at)}
                  </span>
                ) : null}
                {c.status !== "closed" ? (
                  <Button variant="secondary" size="sm" onClick={() => close(c.id)}>
                    Close
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <NewCaseModal open={showNew} onClose={() => setShowNew(false)} contacts={contacts} />
    </div>
  );
}

function NewCaseModal({
  open,
  onClose,
  contacts,
}: {
  open: boolean;
  onClose: () => void;
  contacts: CrmContactWithCompany[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    title: "",
    contact_id: "",
    priority: "normal",
    due_at: "",
    notes: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError("");
    start(async () => {
      const res = await createCase({
        title: form.title,
        contact_id: form.contact_id,
        priority: form.priority as "low" | "normal" | "high",
        due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
        notes: form.notes || undefined,
      });
      if (!res.ok) return setError(res.error);
      onClose();
      setForm({ title: "", contact_id: "", priority: "normal", due_at: "", notes: "" });
      router.refresh();
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="New case">
      <div className="flex flex-col gap-3">
        <Field label="Title">
          <TextInput value={form.title} onChange={set("title")} placeholder="Onboarding, support, renewal…" />
        </Field>
        <Field label="Contact">
          <Select value={form.contact_id} onChange={set("contact_id")}>
            <option value="">Select contact…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {contactName(c)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select value={form.priority} onChange={set("priority")}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </Select>
          </Field>
          <Field label="Due">
            <TextInput type="datetime-local" value={form.due_at} onChange={set("due_at")} />
          </Field>
        </div>
        <Field label="Notes">
          <TextArea value={form.notes} onChange={set("notes")} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !form.title.trim() || !form.contact_id}>
            {pending ? "Saving…" : "Create case"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
