"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, ErrorText, Field, Select, TextArea, TextInput } from "./ui";
import {
  updateCampaign,
  saveCampaignSteps,
  enrollAudience,
  sendCampaignNow,
  scheduleCampaign,
  setCampaignStatus,
  saveSegment,
  saveTemplate,
} from "@/lib/crm/campaign-actions";
import { aiDraftCampaign } from "@/lib/crm/ai-actions";
import {
  LIFECYCLE_STAGES,
  LIFECYCLE_LABEL,
  STEP_KINDS,
  WAIT_EVENTS,
  type CampaignStats,
  type CrmCampaign,
  type CrmCampaignStep,
  type CrmSegment,
  type CrmTemplate,
  type StepKind,
  type WaitEvent,
} from "@/lib/crm/types";

type Step = {
  position: number;
  delay_minutes: number;
  channel: "email" | "sms";
  subject: string;
  body: string;
  kind: StepKind;
  wait_event: WaitEvent | "";
  wait_hours: number | "";
  next_yes: number | "";
  next_no: number | "";
};

function emptyStep(channel: "email" | "sms", position: number, delay_minutes: number): Step {
  return {
    position,
    delay_minutes,
    channel,
    subject: "",
    body: "",
    kind: "send",
    wait_event: "",
    wait_hours: "",
    next_yes: "",
    next_no: "",
  };
}

function stepHint(st: Step): string {
  if (st.kind === "exit") return "Completes the enrollment when reached.";
  if (st.kind === "wait_event") {
    const ev = st.wait_event || "the event";
    const hrs = st.wait_hours === "" ? "no timeout" : `${st.wait_hours}h timeout`;
    const yes = st.next_yes === "" ? "next position" : `step ${Number(st.next_yes) + 1}`;
    const no = st.next_no === "" ? "next position" : `step ${Number(st.next_no) + 1}`;
    return `Wait for ${ev} (${hrs}). If it happens → ${yes}; else → ${no}.`;
  }
  const next = st.next_yes === "" ? "the next position" : `step ${Number(st.next_yes) + 1}`;
  return `Send this message, then continue to ${next}.`;
}

export function CampaignEditor({
  campaign,
  steps: initialSteps,
  stats,
  segments,
  templates,
}: {
  campaign: CrmCampaign;
  steps: CrmCampaignStep[];
  stats: CampaignStats;
  segments: CrmSegment[];
  templates: CrmTemplate[];
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const [subject, setSubject] = useState(campaign.subject ?? "");
  const [body, setBody] = useState(campaign.body ?? "");
  const [audience, setAudience] = useState<{
    stage?: string;
    source?: string;
    tag?: string;
    segment_id?: string;
  }>((campaign.audience as { stage?: string; source?: string; tag?: string; segment_id?: string }) ?? {});
  const [steps, setSteps] = useState<Step[]>(
    initialSteps.map((s) => ({
      position: s.position,
      delay_minutes: s.delay_minutes,
      channel: s.channel,
      subject: s.subject ?? "",
      body: s.body,
      kind: s.kind ?? "send",
      wait_event: s.wait_event ?? "",
      wait_hours: s.wait_hours ?? "",
      next_yes: s.next_yes ?? "",
      next_no: s.next_no ?? "",
    }))
  );
  const [scheduleAt, setScheduleAt] = useState("");

  const isDrip = campaign.type === "drip";
  const isEmail = campaign.channel === "email";
  const usingSegment = Boolean(audience.segment_id);

  function persistAudience() {
    const a: Record<string, unknown> = {};
    if (audience.segment_id) a.segment_id = audience.segment_id;
    else {
      if (audience.stage) a.stage = audience.stage;
      if (audience.source) a.source = audience.source;
      if (audience.tag) a.tag = audience.tag;
    }
    return a;
  }

  function stepsPayload() {
    return steps.map((s, i) => ({
      position: i,
      delay_minutes: s.delay_minutes,
      channel: s.channel,
      subject: s.subject,
      body: s.body,
      kind: s.kind,
      wait_event: s.wait_event || null,
      wait_hours: s.wait_hours === "" ? null : Number(s.wait_hours),
      next_yes: s.next_yes === "" ? null : Number(s.next_yes),
      next_no: s.next_no === "" ? null : Number(s.next_no),
    }));
  }

  function saveBlast() {
    setBusy("save");
    setError("");
    setMsg("");
    start(async () => {
      const res = await updateCampaign(campaign.id, { subject, body, audience: persistAudience() });
      setBusy("");
      if (!res.ok) return setError(res.error);
      setMsg("Saved.");
      router.refresh();
    });
  }

  function saveDrip() {
    setBusy("save");
    setError("");
    setMsg("");
    start(async () => {
      await updateCampaign(campaign.id, { audience: persistAudience() });
      const res = await saveCampaignSteps(campaign.id, stepsPayload());
      setBusy("");
      if (!res.ok) return setError(res.error);
      setMsg("Sequence saved.");
      router.refresh();
    });
  }

  function enroll() {
    setBusy("enroll");
    setError("");
    setMsg("");
    start(async () => {
      const res = await enrollAudience(campaign.id, persistAudience());
      setBusy("");
      if (!res.ok) return setError(res.error);
      setMsg(`Enrolled ${res.data?.enrolled ?? 0} contacts.`);
      router.refresh();
    });
  }

  function sendNow() {
    if (!confirm("Send this blast to the whole audience now? Large lists continue in batches on cron.")) return;
    setBusy("send");
    setError("");
    setMsg("");
    start(async () => {
      await updateCampaign(campaign.id, { subject, body, audience: persistAudience() });
      const res = await sendCampaignNow(campaign.id);
      setBusy("");
      if (!res.ok) return setError(res.error);
      const extra = res.data?.done ? "" : " Remaining recipients send on the next crm-engine tick.";
      setMsg(`Sent ${res.data?.sent ?? 0} (${res.data?.failed ?? 0} failed).${extra}`);
      router.refresh();
    });
  }

  function schedule() {
    if (!scheduleAt) return;
    setBusy("schedule");
    start(async () => {
      await updateCampaign(campaign.id, { subject, body, audience: persistAudience() });
      const res = await scheduleCampaign(campaign.id, new Date(scheduleAt).toISOString());
      setBusy("");
      if (!res.ok) return setError(res.error);
      setMsg("Scheduled.");
      router.refresh();
    });
  }

  function activateDrip() {
    setBusy("activate");
    start(async () => {
      await updateCampaign(campaign.id, { audience: persistAudience() });
      await saveCampaignSteps(campaign.id, stepsPayload());
      const res = await enrollAudience(campaign.id, persistAudience());
      setBusy("");
      if (!res.ok) return setError(res.error);
      setMsg(`Activated. Enrolled ${res.data?.enrolled ?? 0} contacts.`);
      router.refresh();
    });
  }

  function pauseResume(status: "active" | "paused") {
    start(async () => {
      await setCampaignStatus(campaign.id, status);
      router.refresh();
    });
  }

  function aiDraft() {
    const goal = prompt("What's the goal of this message?");
    if (!goal) return;
    setBusy("ai");
    aiDraftCampaign({ goal, channel: campaign.channel, audience: audience.stage }).then((res) => {
      setBusy("");
      if (!res.ok) return setError(res.error);
      const text = res.data!.text;
      if (isEmail) {
        const m = text.match(/^subject:\s*(.+)$/im);
        if (m) {
          setSubject(m[1].trim());
          setBody(text.replace(/^subject:.*$/im, "").trim());
        } else setBody(text);
      } else setBody(text);
    });
  }

  function loadTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (t.subject) setSubject(t.subject);
    setBody(t.body);
    setMsg(`Loaded template “${t.name}”.`);
  }

  function saveCurrentAsTemplate() {
    const name = prompt("Template name?");
    if (!name?.trim()) return;
    setBusy("tpl");
    start(async () => {
      const res = await saveTemplate({
        name: name.trim(),
        channel: campaign.channel,
        subject,
        body,
      });
      setBusy("");
      if (!res.ok) return setError(res.error);
      setMsg("Template saved.");
      router.refresh();
    });
  }

  function saveCurrentAsSegment() {
    const name = prompt("Segment name?");
    if (!name?.trim()) return;
    setBusy("seg");
    start(async () => {
      const res = await saveSegment({
        name: name.trim(),
        filter: { stage: audience.stage, source: audience.source, tag: audience.tag },
      });
      setBusy("");
      if (!res.ok) return setError(res.error);
      if (res.data?.id) setAudience((a) => ({ ...a, segment_id: res.data!.id }));
      setMsg("Segment saved.");
      router.refresh();
    });
  }

  function applySegment(id: string) {
    if (!id) {
      setAudience((a) => {
        const next = { ...a };
        delete next.segment_id;
        return next;
      });
      return;
    }
    const seg = segments.find((s) => s.id === id);
    const f = (seg?.filter ?? {}) as { stage?: string; source?: string; tag?: string };
    setAudience({
      segment_id: id,
      stage: typeof f.stage === "string" ? f.stage : undefined,
      source: typeof f.source === "string" ? f.source : undefined,
      tag: typeof f.tag === "string" ? f.tag : undefined,
    });
  }

  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-5">
        {!isDrip ? (
          <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-ink">Message</h2>
              <Button variant="ghost" size="sm" onClick={aiDraft} disabled={busy === "ai"}>
                {busy === "ai" ? "Drafting…" : "✨ AI draft"}
              </Button>
            </div>
            <div className="mt-3 flex flex-col gap-3">
              {templates.length > 0 ? (
                <Field label="Load template">
                  <Select defaultValue="" onChange={(e) => e.target.value && loadTemplate(e.target.value)}>
                    <option value="">Choose a template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {isEmail ? (
                <Field label="Subject">
                  <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} />
                </Field>
              ) : null}
              <Field label="Body" hint="Use {{first_name}} for personalization.">
                <TextArea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[200px]" />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={saveCurrentAsTemplate} disabled={busy === "tpl"}>
                  {busy === "tpl" ? "Saving…" : "Save as template"}
                </Button>
                <Button onClick={saveBlast} disabled={busy === "save"}>
                  {busy === "save" ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-ink">Journey steps</h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setSteps((s) => [...s, emptyStep(campaign.channel, s.length, s.length === 0 ? 0 : 1440)])
                }
              >
                + Add step
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-soft">
              Send, then wait for open/click/reply/stage change, then branch. Yes/No are 0-based step positions
              (step 1 = 0). Linear drips stay send → next position.
            </p>
            <div className="mt-3 flex flex-col gap-4">
              {steps.length === 0 ? <p className="text-sm text-muted-soft">No steps yet. Add the first message.</p> : null}
              {steps.map((st, i) => (
                <div key={i} className="rounded-xl border border-line p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold text-muted">
                      Step {i + 1} <span className="font-medium text-muted-soft">(position {i})</span>
                    </span>
                    <button
                      onClick={() => setSteps((s) => s.filter((_, j) => j !== i))}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <p className="mb-2 text-xs text-muted-soft">{stepHint(st)}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Kind">
                      <Select
                        value={st.kind}
                        onChange={(e) =>
                          setSteps((s) => s.map((x, j) => (j === i ? { ...x, kind: e.target.value as StepKind } : x)))
                        }
                      >
                        {STEP_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k === "wait_event" ? "Wait for event" : k === "exit" ? "Exit" : "Send"}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Delay (minutes before this step)">
                      <TextInput
                        type="number"
                        value={String(st.delay_minutes)}
                        onChange={(e) =>
                          setSteps((s) => s.map((x, j) => (j === i ? { ...x, delay_minutes: Number(e.target.value) || 0 } : x)))
                        }
                      />
                    </Field>
                    {st.kind === "send" ? (
                      <Field label="Channel">
                        <Select
                          value={st.channel}
                          onChange={(e) =>
                            setSteps((s) => s.map((x, j) => (j === i ? { ...x, channel: e.target.value as "email" | "sms" } : x)))
                          }
                        >
                          <option value="email">Email</option>
                          <option value="sms">SMS</option>
                        </Select>
                      </Field>
                    ) : null}
                    {st.kind === "wait_event" ? (
                      <>
                        <Field label="Wait for">
                          <Select
                            value={st.wait_event}
                            onChange={(e) =>
                              setSteps((s) =>
                                s.map((x, j) => (j === i ? { ...x, wait_event: e.target.value as WaitEvent | "" } : x))
                              )
                            }
                          >
                            <option value="">Choose event…</option>
                            {WAIT_EVENTS.map((ev) => (
                              <option key={ev} value={ev}>
                                {ev === "stage_changed" ? "Stage changed" : ev}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Wait hours (timeout → No path)">
                          <TextInput
                            type="number"
                            value={String(st.wait_hours)}
                            onChange={(e) =>
                              setSteps((s) =>
                                s.map((x, j) =>
                                  j === i ? { ...x, wait_hours: e.target.value === "" ? "" : Number(e.target.value) } : x
                                )
                              )
                            }
                          />
                        </Field>
                      </>
                    ) : null}
                    <Field label="Next yes (position)">
                      <TextInput
                        type="number"
                        placeholder="default: +1"
                        value={String(st.next_yes)}
                        onChange={(e) =>
                          setSteps((s) =>
                            s.map((x, j) => (j === i ? { ...x, next_yes: e.target.value === "" ? "" : Number(e.target.value) } : x))
                          )
                        }
                      />
                    </Field>
                    {st.kind === "wait_event" ? (
                      <Field label="Next no (position)">
                        <TextInput
                          type="number"
                          placeholder="default: +1"
                          value={String(st.next_no)}
                          onChange={(e) =>
                            setSteps((s) =>
                              s.map((x, j) => (j === i ? { ...x, next_no: e.target.value === "" ? "" : Number(e.target.value) } : x))
                            )
                          }
                        />
                      </Field>
                    ) : null}
                  </div>
                  {st.kind === "send" && st.channel === "email" ? (
                    <div className="mt-2">
                      <TextInput
                        placeholder="Subject"
                        value={st.subject}
                        onChange={(e) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))}
                      />
                    </div>
                  ) : null}
                  {st.kind === "send" ? (
                    <div className="mt-2">
                      <TextArea
                        placeholder="Message body… {{first_name}}"
                        value={st.body}
                        onChange={(e) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
              <div className="flex justify-end">
                <Button onClick={saveDrip} disabled={busy === "save"}>
                  {busy === "save" ? "Saving…" : "Save sequence"}
                </Button>
              </div>
            </div>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
        {msg ? <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">{msg}</p> : null}
      </div>

      <div className="flex flex-col gap-5">
        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <h2 className="text-sm font-bold text-ink">Audience</h2>
          <div className="mt-3 flex flex-col gap-3">
            <Field label="Saved segment" hint="Pick a saved filter or keep editing ad-hoc fields.">
              <Select value={audience.segment_id ?? ""} onChange={(e) => applySegment(e.target.value)}>
                <option value="">Ad-hoc (not a saved segment)</option>
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Lifecycle stage">
              <Select
                value={audience.stage ?? ""}
                disabled={usingSegment}
                onChange={(e) => setAudience((a) => ({ ...a, stage: e.target.value || undefined }))}
              >
                <option value="">Any</option>
                {LIFECYCLE_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {LIFECYCLE_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Source">
              <TextInput
                placeholder="Any"
                disabled={usingSegment}
                value={audience.source ?? ""}
                onChange={(e) => setAudience((a) => ({ ...a, source: e.target.value || undefined }))}
              />
            </Field>
            <Field label="Tag">
              <TextInput
                placeholder="Any"
                disabled={usingSegment}
                value={audience.tag ?? ""}
                onChange={(e) => setAudience((a) => ({ ...a, tag: e.target.value || undefined }))}
              />
            </Field>
            <Button variant="secondary" size="sm" onClick={saveCurrentAsSegment} disabled={busy === "seg" || usingSegment}>
              {busy === "seg" ? "Saving…" : "Save filters as segment"}
            </Button>
            <p className="text-xs text-muted-soft">
              {isEmail ? "Excludes do-not-email and contacts without an email." : "Excludes do-not-SMS and contacts without a phone."}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <h2 className="text-sm font-bold text-ink">Launch</h2>
          <div className="mt-3 flex flex-col gap-2">
            {!isDrip ? (
              <>
                <Button onClick={sendNow} disabled={!!busy}>
                  {busy === "send" ? "Sending…" : "Send now"}
                </Button>
                <div className="flex gap-2">
                  <TextInput type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="flex-1" />
                  <Button variant="secondary" onClick={schedule} disabled={!!busy || !scheduleAt}>
                    Schedule
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Button onClick={activateDrip} disabled={!!busy}>
                  {busy === "activate" ? "Activating…" : "Activate & enroll audience"}
                </Button>
                <Button variant="secondary" onClick={enroll} disabled={!!busy}>
                  {busy === "enroll" ? "…" : "Enroll audience (no activate)"}
                </Button>
                {campaign.status === "active" ? (
                  <Button variant="secondary" onClick={() => pauseResume("paused")}>
                    Pause
                  </Button>
                ) : campaign.status === "paused" ? (
                  <Button variant="secondary" onClick={() => pauseResume("active")}>
                    Resume
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink">Stats</h2>
            <Badge tone={campaign.status === "active" || campaign.status === "sending" ? "green" : "neutral"}>{campaign.status}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Enrolled" value={stats.enrolled} />
            <Stat label="Active" value={stats.active} />
            <Stat label="Completed" value={stats.completed} />
            <Stat label="Messages" value={stats.messages} />
            <Stat label="Sent" value={stats.sent} />
            <Stat label="Delivered" value={stats.delivered} />
            <Stat label="Opened" value={stats.opened} />
            <Stat label="Clicked" value={stats.clicked} />
            <Stat label="Bounced" value={stats.bounced} />
          </dl>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-paper-soft p-3">
      <dt className="text-xs text-muted-soft">{label}</dt>
      <dd className="text-xl font-bold text-ink">{value}</dd>
    </div>
  );
}
