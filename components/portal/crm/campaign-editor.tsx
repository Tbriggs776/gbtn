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
} from "@/lib/crm/campaign-actions";
import { aiDraftCampaign } from "@/lib/crm/ai-actions";
import { LIFECYCLE_STAGES, LIFECYCLE_LABEL, type CrmCampaign, type CrmCampaignStep } from "@/lib/crm/types";

type Stats = { enrolled: number; active: number; completed: number; messages: number };
type Step = { position: number; delay_minutes: number; channel: "email" | "sms"; subject: string; body: string };

export function CampaignEditor({
  campaign,
  steps: initialSteps,
  stats,
}: {
  campaign: CrmCampaign;
  steps: CrmCampaignStep[];
  stats: Stats;
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const [subject, setSubject] = useState(campaign.subject ?? "");
  const [body, setBody] = useState(campaign.body ?? "");
  const [audience, setAudience] = useState<{ stage?: string; source?: string; tag?: string }>(
    (campaign.audience as { stage?: string; source?: string; tag?: string }) ?? {}
  );
  const [steps, setSteps] = useState<Step[]>(
    initialSteps.map((s) => ({
      position: s.position,
      delay_minutes: s.delay_minutes,
      channel: s.channel,
      subject: s.subject ?? "",
      body: s.body,
    }))
  );
  const [scheduleAt, setScheduleAt] = useState("");

  const isDrip = campaign.type === "drip";
  const isEmail = campaign.channel === "email";

  function saveBlast() {
    setBusy("save");
    setError("");
    setMsg("");
    start(async () => {
      const res = await updateCampaign(campaign.id, { subject, body, audience });
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
      await updateCampaign(campaign.id, { audience });
      const res = await saveCampaignSteps(campaign.id, steps);
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
      const res = await enrollAudience(campaign.id, audience);
      setBusy("");
      if (!res.ok) return setError(res.error);
      setMsg(`Enrolled ${res.data?.enrolled ?? 0} contacts.`);
      router.refresh();
    });
  }

  function sendNow() {
    if (!confirm("Send this blast to the whole audience now?")) return;
    setBusy("send");
    setError("");
    setMsg("");
    start(async () => {
      await updateCampaign(campaign.id, { subject, body, audience });
      const res = await sendCampaignNow(campaign.id);
      setBusy("");
      if (!res.ok) return setError(res.error);
      setMsg(`Sent ${res.data?.sent ?? 0} (${res.data?.failed ?? 0} failed).`);
      router.refresh();
    });
  }

  function schedule() {
    if (!scheduleAt) return;
    setBusy("schedule");
    start(async () => {
      await updateCampaign(campaign.id, { subject, body, audience });
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
      await updateCampaign(campaign.id, { audience });
      await saveCampaignSteps(campaign.id, steps);
      const res = await enrollAudience(campaign.id, audience);
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

  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_320px]">
      {/* Editor */}
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
              {isEmail ? (
                <Field label="Subject">
                  <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} />
                </Field>
              ) : null}
              <Field label="Body" hint="Use {{first_name}} for personalization.">
                <TextArea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[200px]" />
              </Field>
              <div className="flex justify-end">
                <Button onClick={saveBlast} disabled={busy === "save"}>
                  {busy === "save" ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-ink">Sequence steps</h2>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setSteps((s) => [
                    ...s,
                    { position: s.length, delay_minutes: s.length === 0 ? 0 : 1440, channel: campaign.channel, subject: "", body: "" },
                  ])
                }
              >
                + Add step
              </Button>
            </div>
            <div className="mt-3 flex flex-col gap-4">
              {steps.length === 0 ? <p className="text-sm text-muted-soft">No steps yet. Add the first message.</p> : null}
              {steps.map((st, i) => (
                <div key={i} className="rounded-xl border border-line p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-bold text-muted">Step {i + 1}</span>
                    <button
                      onClick={() => setSteps((s) => s.filter((_, j) => j !== i))}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Delay (minutes after enrollment)">
                      <TextInput
                        type="number"
                        value={String(st.delay_minutes)}
                        onChange={(e) =>
                          setSteps((s) => s.map((x, j) => (j === i ? { ...x, delay_minutes: Number(e.target.value) || 0 } : x)))
                        }
                      />
                    </Field>
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
                  </div>
                  {st.channel === "email" ? (
                    <div className="mt-2">
                      <TextInput
                        placeholder="Subject"
                        value={st.subject}
                        onChange={(e) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))}
                      />
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <TextArea
                      placeholder="Message body… {{first_name}}"
                      value={st.body}
                      onChange={(e) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
                    />
                  </div>
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

      {/* Side: audience + actions + stats */}
      <div className="flex flex-col gap-5">
        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <h2 className="text-sm font-bold text-ink">Audience</h2>
          <div className="mt-3 flex flex-col gap-3">
            <Field label="Lifecycle stage">
              <Select value={audience.stage ?? ""} onChange={(e) => setAudience((a) => ({ ...a, stage: e.target.value || undefined }))}>
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
                value={audience.source ?? ""}
                onChange={(e) => setAudience((a) => ({ ...a, source: e.target.value || undefined }))}
              />
            </Field>
            <Field label="Tag">
              <TextInput
                placeholder="Any"
                value={audience.tag ?? ""}
                onChange={(e) => setAudience((a) => ({ ...a, tag: e.target.value || undefined }))}
              />
            </Field>
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
            <Badge tone={campaign.status === "active" ? "green" : "neutral"}>{campaign.status}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Stat label="Enrolled" value={stats.enrolled} />
            <Stat label="Active" value={stats.active} />
            <Stat label="Completed" value={stats.completed} />
            <Stat label="Messages" value={stats.messages} />
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
