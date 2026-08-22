"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, ErrorText, Field, Modal, Select, TextArea, TextInput } from "./ui";
import { createContact } from "@/lib/crm/actions";
import { importContacts } from "@/lib/crm/import-actions";
import { LIFECYCLE_STAGES, LIFECYCLE_LABEL, type LifecycleStage } from "@/lib/crm/types";

type Company = { id: string; name: string };

export function ContactsToolbar({ companies }: { companies: Company[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);

  function applyFilters(next: Record<string, string>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    router.push(`/portal/crm/contacts?${p.toString()}`);
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters({ q: search });
        }}
        className="flex-1 min-w-[200px]"
      >
        <TextInput
          placeholder="Search name, email, phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </form>
      <Select
        value={params.get("stage") ?? ""}
        onChange={(e) => applyFilters({ stage: e.target.value })}
        className="w-auto"
      >
        <option value="">All stages</option>
        {LIFECYCLE_STAGES.map((s) => (
          <option key={s} value={s}>
            {LIFECYCLE_LABEL[s]}
          </option>
        ))}
      </Select>
      <Button variant="secondary" onClick={() => setShowImport(true)}>
        Import CSV
      </Button>
      <Button onClick={() => setShowNew(true)}>+ New contact</Button>

      <NewContactModal open={showNew} onClose={() => setShowNew(false)} companies={companies} />
      <ImportModal open={showImport} onClose={() => setShowImport(false)} />
    </div>
  );
}

function NewContactModal({
  open,
  onClose,
  companies,
}: {
  open: boolean;
  onClose: () => void;
  companies: Company[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    title: "",
    company_id: "",
    lifecycle_stage: "lead" as LifecycleStage,
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError("");
    start(async () => {
      const res = await createContact({
        ...form,
        company_id: form.company_id || null,
      });
      if (!res.ok) return setError(res.error);
      onClose();
      if (res.data?.id) router.push(`/portal/crm/contacts/${res.data.id}`);
      else router.refresh();
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="New contact">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <TextInput value={form.first_name} onChange={set("first_name")} />
          </Field>
          <Field label="Last name">
            <TextInput value={form.last_name} onChange={set("last_name")} />
          </Field>
        </div>
        <Field label="Email">
          <TextInput type="email" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Phone">
          <TextInput value={form.phone} onChange={set("phone")} placeholder="+1 480 555 1234" />
        </Field>
        <Field label="Title">
          <TextInput value={form.title} onChange={set("title")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company">
            <Select value={form.company_id} onChange={set("company_id")}>
              <option value="">—</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Stage">
            <Select value={form.lifecycle_stage} onChange={set("lifecycle_stage")}>
              {LIFECYCLE_STAGES.map((s) => (
                <option key={s} value={s}>
                  {LIFECYCLE_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Create contact"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [csv, setCsv] = useState("");

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then(setCsv);
  }

  function submit() {
    setError("");
    setResult("");
    start(async () => {
      const res = await importContacts(csv);
      if (!res.ok) return setError(res.error);
      setResult(
        `Imported ${res.data?.imported ?? 0} contacts (${res.data?.skipped ?? 0} skipped, ${res.data?.companies ?? 0} companies created).`
      );
      router.refresh();
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Import contacts from CSV" wide>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          Header row required. Recognized columns: first name, last name, email, phone, company,
          title, source, notes. Existing emails are skipped.
        </p>
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-sm text-muted" />
        <TextArea
          placeholder="…or paste CSV here"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          className="min-h-[160px] font-mono text-xs"
        />
        <ErrorText>{error}</ErrorText>
        {result ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">{result}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={submit} disabled={pending || !csv.trim()}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
