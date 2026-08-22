"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, ErrorText, Field, Modal, TextArea, TextInput } from "./ui";
import { createCompany } from "@/lib/crm/actions";

export function NewCompanyButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", domain: "", website: "", phone: "", industry: "", notes: "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError("");
    start(async () => {
      const res = await createCompany(form);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      setForm({ name: "", domain: "", website: "", phone: "", industry: "", notes: "" });
      if (res.data?.id) router.push(`/portal/crm/companies/${res.data.id}`);
      else router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>+ New company</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="New company">
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <TextInput value={form.name} onChange={set("name")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Domain">
              <TextInput value={form.domain} onChange={set("domain")} placeholder="acme.com" />
            </Field>
            <Field label="Phone">
              <TextInput value={form.phone} onChange={set("phone")} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Website">
              <TextInput value={form.website} onChange={set("website")} />
            </Field>
            <Field label="Industry">
              <TextInput value={form.industry} onChange={set("industry")} />
            </Field>
          </div>
          <Field label="Notes">
            <TextArea value={form.notes} onChange={set("notes")} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending || !form.name.trim()}>
              {pending ? "Saving…" : "Create company"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
