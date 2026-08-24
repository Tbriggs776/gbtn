"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, ErrorText, Field, Select, TextArea, TextInput } from "./ui";
import { Contact360 } from "./contact-360";
import {
  emailContact,
  smsContact,
  callContact,
  logActivity,
  createTask,
  setTaskStatus,
  updateContact,
  createCase,
  closeCase,
} from "@/lib/crm/actions";
import { aiSummarize, aiNextAction, aiDraft, aiScore } from "@/lib/crm/ai-actions";
import {
  contactName,
  LIFECYCLE_STAGES,
  LIFECYCLE_LABEL,
  type CrmActivity,
  type CrmCase,
  type CrmContactWithCompany,
  type CrmTask,
  type CrmDeal,
  type CrmEnrollmentWithCampaign,
} from "@/lib/crm/types";
import { formatDate, relativeTime, formatCurrency } from "@/lib/format";

const TYPE_ICON: Record<string, string> = {
  note: "M4 5h16M4 12h10M4 19h7",
  email: "M3 6h18v12H3zM3 6l9 7 9-7",
  sms: "M4 5h16v10H8l-4 4z",
  call: "M4 4h4l2 5-3 2a12 12 0 006 6l2-3 5 2v4a2 2 0 01-2 2A16 16 0 014 6a2 2 0 012-2",
  meeting: "M8 2v3M16 2v3M4 8h16M5 5h14v15H5z",
  stage_change: "M4 12h16M14 6l6 6-6 6",
  form_submission: "M7 3h7l5 5v13H7zM14 3v5h5",
  enrollment: "M12 2l3 6 6 1-4 4 1 6-6-3-6 3 1-6-4-4 6-1z",
  system: "M12 6v6l4 2",
};

type Tab = "note" | "email" | "sms" | "call";

export function ContactWorkspace({
  contact,
  timeline,
  tasks,
  deals,
  cases,
  lastEnrollment,
}: {
  contact: CrmContactWithCompany;
  timeline: CrmActivity[];
  tasks: CrmTask[];
  deals: CrmDeal[];
  cases: CrmCase[];
  lastEnrollment: CrmEnrollmentWithCampaign | null;
}) {
  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-5">
        <Contact360 contact={contact} deals={deals} cases={cases} lastEnrollment={lastEnrollment} />
        <Composer contact={contact} />
        <Timeline items={timeline} />
      </div>
      <div className="flex flex-col gap-5">
        <AiPanel contact={contact} />
        <Details contact={contact} />
        <Cases contactId={contact.id} cases={cases} />
        <Tasks contactId={contact.id} tasks={tasks} />
        <Deals contactId={contact.id} deals={deals} />
      </div>
    </div>
  );
}

function Composer({ contact }: { contact: CrmContactWithCompany }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("note");
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [connected, setConnected] = useState(true);
  const [agentNumber, setAgentNumber] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const tabs: { key: Tab; label: string }[] = [
    { key: "note", label: "Note" },
    { key: "email", label: "Email" },
    { key: "sms", label: "SMS" },
    { key: "call", label: "Call" },
  ];

  function reset() {
    setSubject("");
    setBody("");
    setError("");
  }

  function submit() {
    setError("");
    start(async () => {
      let res;
      if (tab === "note") res = await logActivity({ contact_id: contact.id, type: "note", body });
      else if (tab === "email") res = await emailContact({ contact_id: contact.id, subject, body });
      else if (tab === "sms") res = await smsContact({ contact_id: contact.id, body });
      else res = await logActivity({ contact_id: contact.id, type: "call", body, connected });
      if (!res.ok) return setError(res.error);
      reset();
      router.refresh();
    });
  }

  function placeCall() {
    setError("");
    start(async () => {
      const res = await callContact({ contact_id: contact.id, agent_number: agentNumber });
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  function aiDraftFor(channel: "email" | "sms") {
    setAiBusy(true);
    setError("");
    aiDraft(contact.id, channel).then((res) => {
      setAiBusy(false);
      if (!res.ok) return setError(res.error);
      const text = res.data!.text;
      if (channel === "email") {
        const m = text.match(/^subject:\s*(.+)$/im);
        if (m) {
          setSubject(m[1].trim());
          setBody(text.replace(/^subject:.*$/im, "").trim());
        } else setBody(text);
      } else setBody(text);
    });
  }

  return (
    <div className="rounded-2xl border border-line bg-white ring-soft">
      <div className="flex items-center gap-1 border-b border-line px-3 pt-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setError("");
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.key ? "border-brand-700 text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3 p-4">
        {tab === "email" && contact.email ? (
          <TextInput placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
        ) : null}

        {tab === "call" ? (
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={connected} onChange={(e) => setConnected(e.target.checked)} />
              Connected (reached them)
            </label>
            <TextArea placeholder="Call notes…" value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={submit} disabled={pending} size="sm">
                {pending ? "Saving…" : "Log call"}
              </Button>
              <span className="text-xs text-muted-soft">or click-to-call:</span>
              <TextInput
                placeholder="Your phone"
                value={agentNumber}
                onChange={(e) => setAgentNumber(e.target.value)}
                className="w-40"
              />
              <Button variant="secondary" size="sm" onClick={placeCall} disabled={pending || !agentNumber}>
                Call now
              </Button>
            </div>
          </div>
        ) : (
          <>
            <TextArea
              placeholder={
                tab === "note"
                  ? "Log a note…"
                  : tab === "email"
                    ? contact.email
                      ? `Email ${contact.email}…`
                      : "No email on file"
                    : contact.phone
                      ? `Text ${contact.phone}…`
                      : "No phone on file"
              }
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                {tab === "email" ? (
                  <Button variant="ghost" size="sm" onClick={() => aiDraftFor("email")} disabled={aiBusy}>
                    {aiBusy ? "Drafting…" : "✨ AI draft"}
                  </Button>
                ) : null}
                {tab === "sms" ? (
                  <Button variant="ghost" size="sm" onClick={() => aiDraftFor("sms")} disabled={aiBusy}>
                    {aiBusy ? "Drafting…" : "✨ AI draft"}
                  </Button>
                ) : null}
              </div>
              <Button
                onClick={submit}
                disabled={
                  pending ||
                  !body.trim() ||
                  (tab === "email" && !contact.email) ||
                  (tab === "sms" && !contact.phone)
                }
                size="sm"
              >
                {pending
                  ? "Working…"
                  : tab === "note"
                    ? "Save note"
                    : tab === "email"
                      ? "Send email"
                      : "Send SMS"}
              </Button>
            </div>
          </>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}

function Timeline({ items }: { items: CrmActivity[] }) {
  if (items.length === 0)
    return (
      <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-12 text-center text-sm text-muted">
        No activity yet. Log a note or reach out above.
      </div>
    );
  return (
    <div className="rounded-2xl border border-line bg-white ring-soft">
      <div className="border-b border-line px-5 py-3">
        <h2 className="text-sm font-bold text-ink">Activity</h2>
      </div>
      <ol className="flex flex-col">
        {items.map((a) => (
          <li key={a.id} className="flex gap-3 border-b border-line px-5 py-3.5 last:border-0">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-paper-soft text-muted">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
                <path d={TYPE_ICON[a.type] ?? TYPE_ICON.system} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-ink">
                  {a.subject || labelForType(a.type)}
                  {a.direction ? (
                    <span className="ml-2 text-xs font-normal text-muted-soft">{a.direction}</span>
                  ) : null}
                </p>
                <time className="shrink-0 text-xs text-muted-soft" title={formatDate(a.occurred_at)}>
                  {relativeTime(a.occurred_at)}
                </time>
              </div>
              {a.body ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{a.body}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function labelForType(t: string): string {
  const map: Record<string, string> = {
    note: "Note",
    email: "Email",
    sms: "Text message",
    call: "Call",
    meeting: "Meeting",
    stage_change: "Stage change",
    form_submission: "Form submission",
    enrollment: "Campaign enrollment",
    system: "System",
  };
  return map[t] ?? t;
}

function AiPanel({ contact }: { contact: CrmContactWithCompany }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [out, setOut] = useState("");
  const [error, setError] = useState("");

  function run(kind: "summary" | "next" | "score") {
    setBusy(kind);
    setError("");
    setOut("");
    const p =
      kind === "summary"
        ? aiSummarize(contact.id)
        : kind === "next"
          ? aiNextAction(contact.id)
          : aiScore(contact.id);
    p.then((res) => {
      setBusy("");
      if (!res.ok) return setError(res.error);
      if (kind === "score") {
        const d = res.data as { score: number; rationale: string };
        setOut(`Lead score: ${d.score}/100 — ${d.rationale}`);
        router.refresh();
      } else {
        setOut((res.data as { text: string }).text);
      }
    });
  }

  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <h2 className="text-sm font-bold text-ink">AI assistant</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => run("summary")} disabled={!!busy}>
          {busy === "summary" ? "…" : "Summarize"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => run("next")} disabled={!!busy}>
          {busy === "next" ? "…" : "Next best action"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => run("score")} disabled={!!busy}>
          {busy === "score" ? "…" : "Score lead"}
        </Button>
      </div>
      {out ? <p className="mt-3 whitespace-pre-wrap rounded-xl bg-paper-soft p-3 text-sm text-ink">{out}</p> : null}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function Details({ contact }: { contact: CrmContactWithCompany }) {
  const router = useRouter();
  const [, start] = useTransition();
  const save = (patch: Record<string, unknown>) =>
    start(async () => {
      await updateContact(contact.id, patch);
      router.refresh();
    });

  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <h2 className="text-sm font-bold text-ink">Details</h2>
      <div className="mt-3 flex flex-col gap-3">
        <Field label="Lifecycle stage">
          <Select defaultValue={contact.lifecycle_stage} onChange={(e) => save({ lifecycle_stage: e.target.value })}>
            {LIFECYCLE_STAGES.map((s) => (
              <option key={s} value={s}>
                {LIFECYCLE_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <dl className="flex flex-col gap-1.5 text-sm">
          <Row label="Email" value={contact.email} />
          <Row label="Phone" value={contact.phone} />
          <Row label="Title" value={contact.title} />
          <Row label="Company" value={contact.company?.name} />
          <Row label="Source" value={contact.source} />
          <Row label="Last attempt" value={contact.last_attempt_at ? relativeTime(contact.last_attempt_at) : "—"} />
          <Row label="Last connected" value={contact.last_contacted_at ? relativeTime(contact.last_contacted_at) : "—"} />
          <Row label="Lifetime value" value={formatCurrency(Number(contact.lifetime_value || 0))} />
          <Row label="MRR" value={formatCurrency(Number(contact.mrr || 0))} />
          <Row label="Won deals" value={String(contact.won_deal_count ?? 0)} />
        </dl>
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <label className="flex items-center justify-between text-sm text-muted">
            Do not email
            <input
              type="checkbox"
              defaultChecked={contact.do_not_email}
              onChange={(e) => save({ do_not_email: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between text-sm text-muted">
            Do not SMS
            <input
              type="checkbox"
              defaultChecked={contact.do_not_sms}
              onChange={(e) => save({ do_not_sms: e.target.checked })}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-soft">{label}</dt>
      <dd className="truncate text-right text-ink">{value || "—"}</dd>
    </div>
  );
}

function Cases({ contactId, cases }: { contactId: string; cases: CrmCase[] }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [title, setTitle] = useState("");

  function add() {
    if (!title.trim()) return;
    start(async () => {
      await createCase({ title, contact_id: contactId });
      setTitle("");
      router.refresh();
    });
  }
  function close(id: string) {
    start(async () => {
      await closeCase(id);
      router.refresh();
    });
  }

  const open = cases.filter((c) => c.status !== "closed");
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <h2 className="text-sm font-bold text-ink">Cases</h2>
      <div className="mt-3 flex flex-col gap-2">
        {open.length === 0 ? <p className="text-sm text-muted-soft">No open cases.</p> : null}
        {open.map((c) => (
          <div key={c.id} className="flex items-start justify-between gap-2 text-sm">
            <span>
              <span className="text-ink">{c.title}</span>
              {c.due_at ? (
                <span className={`ml-2 text-xs ${new Date(c.due_at) < new Date() ? "text-brand-700" : "text-muted-soft"}`}>
                  {relativeTime(c.due_at)}
                </span>
              ) : null}
            </span>
            <Button variant="ghost" size="sm" onClick={() => close(c.id)}>
              Close
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2 border-t border-line pt-3">
        <TextInput placeholder="New case…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button size="sm" onClick={add} disabled={!title.trim()}>
          Add
        </Button>
      </div>
    </div>
  );
}

function Tasks({ contactId, tasks }: { contactId: string; tasks: CrmTask[] }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");

  function add() {
    if (!title.trim()) return;
    start(async () => {
      await createTask({ title, contact_id: contactId, due_at: due ? new Date(due).toISOString() : null });
      setTitle("");
      setDue("");
      router.refresh();
    });
  }
  function toggle(id: string, done: boolean) {
    start(async () => {
      await setTaskStatus(id, done ? "done" : "open");
      router.refresh();
    });
  }

  const open = tasks.filter((t) => t.status === "open");
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <h2 className="text-sm font-bold text-ink">Tasks</h2>
      <div className="mt-3 flex flex-col gap-2">
        {open.length === 0 ? <p className="text-sm text-muted-soft">No open tasks.</p> : null}
        {open.map((t) => (
          <label key={t.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" onChange={(e) => toggle(t.id, e.target.checked)} />
            <span>
              <span className="text-ink">{t.title}</span>
              {t.due_at ? (
                <span className={`ml-2 text-xs ${new Date(t.due_at) < new Date() ? "text-brand-700" : "text-muted-soft"}`}>
                  {relativeTime(t.due_at)}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
        <TextInput placeholder="New task…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="flex gap-2">
          <TextInput type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="flex-1" />
          <Button size="sm" onClick={add} disabled={!title.trim()}>
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function Deals({ contactId, deals }: { contactId: string; deals: CrmDeal[] }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-ink">Deals</h2>
        <span className="text-xs text-muted-soft">{deals.length}</span>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {deals.length === 0 ? <p className="text-sm text-muted-soft">No deals linked.</p> : null}
        {deals.map((d) => (
          <div key={d.id} className="flex items-center justify-between rounded-xl bg-paper-soft px-3 py-2">
            <span className="truncate text-sm text-ink">{d.title}</span>
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold text-ink">{formatCurrency(Number(d.value))}</span>
              <Badge tone={d.status === "won" ? "green" : d.status === "lost" ? "red" : "blue"}>{d.status}</Badge>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
