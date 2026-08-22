"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, ErrorText, Field, Modal, Select, TextInput } from "./ui";
import { createCampaign } from "@/lib/crm/campaign-actions";

export function NewCampaignButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", channel: "email" as "email" | "sms", type: "blast" as "blast" | "drip" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError("");
    start(async () => {
      const res = await createCampaign(form);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      if (res.data?.id) router.push(`/portal/crm/campaigns/${res.data.id}`);
      else router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>+ New campaign</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="New campaign">
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <TextInput value={form.name} onChange={set("name")} placeholder="e.g. Q3 operator nurture" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Channel">
              <Select value={form.channel} onChange={set("channel")}>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </Select>
            </Field>
            <Field label="Type" hint={form.type === "drip" ? "Multi-step sequence" : "One-time send"}>
              <Select value={form.type} onChange={set("type")}>
                <option value="blast">Blast</option>
                <option value="drip">Drip sequence</option>
              </Select>
            </Field>
          </div>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !form.name.trim()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
