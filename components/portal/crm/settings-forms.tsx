"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, ErrorText, Field, TextInput } from "./ui";
import { saveTwilioConfig, saveCallRailConfig } from "@/lib/crm/settings-actions";

export function TwilioForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [f, setF] = useState({ accountSid: "", authToken: "", fromNumber: "", messagingServiceSid: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  function submit() {
    setError("");
    setMsg("");
    start(async () => {
      const res = await saveTwilioConfig(f);
      if (!res.ok) return setError(res.error);
      setMsg("Twilio credentials saved.");
      setF({ accountSid: "", authToken: "", fromNumber: "", messagingServiceSid: "" });
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-ink">Twilio (SMS & Voice)</h2>
        <Badge tone={configured ? "green" : "neutral"}>{configured ? "Connected" : "Not configured"}</Badge>
      </div>
      <p className="mt-1 mb-4 text-sm text-muted">
        Stored encrypted in Vault. Leave a field blank to keep its current value.
      </p>
      <div className="flex flex-col gap-3">
        <Field label="Account SID">
          <TextInput value={f.accountSid} onChange={set("accountSid")} placeholder="AC…" />
        </Field>
        <Field label="Auth Token">
          <TextInput type="password" value={f.authToken} onChange={set("authToken")} placeholder="••••••••" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From number (E.164)">
            <TextInput value={f.fromNumber} onChange={set("fromNumber")} placeholder="+18885551234" />
          </Field>
          <Field label="Messaging Service SID" hint="optional; preferred over From">
            <TextInput value={f.messagingServiceSid} onChange={set("messagingServiceSid")} placeholder="MG…" />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        {msg ? <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">{msg}</p> : null}
        <div className="flex justify-end">
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save Twilio"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CallRailForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [f, setF] = useState({ apiKey: "", accountId: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  function submit() {
    setError("");
    setMsg("");
    start(async () => {
      const res = await saveCallRailConfig(f);
      if (!res.ok) return setError(res.error);
      setMsg("CallRail credentials saved.");
      setF({ apiKey: "", accountId: "" });
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-ink">CallRail (call logging)</h2>
        <Badge tone={configured ? "green" : "neutral"}>{configured ? "Connected" : "Not configured"}</Badge>
      </div>
      <p className="mt-1 mb-4 text-sm text-muted">Used to pull calls into contact timelines.</p>
      <div className="flex flex-col gap-3">
        <Field label="API key">
          <TextInput type="password" value={f.apiKey} onChange={set("apiKey")} placeholder="••••••••" />
        </Field>
        <Field label="Account ID">
          <TextInput value={f.accountId} onChange={set("accountId")} placeholder="ACC…" />
        </Field>
        <ErrorText>{error}</ErrorText>
        {msg ? <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">{msg}</p> : null}
        <div className="flex justify-end">
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save CallRail"}
          </Button>
        </div>
      </div>
    </div>
  );
}
