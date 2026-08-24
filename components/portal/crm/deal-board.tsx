"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button, ErrorText, Field, Modal, Select, TextArea, TextInput } from "./ui";
import { createDeal, moveDealStage } from "@/lib/crm/actions";
import { formatCurrency } from "@/lib/format";
import type { CrmDealJoined, CrmStage } from "@/lib/crm/types";
import { contactName } from "@/lib/crm/types";

type Opt = { id: string; name: string };

export function DealBoard({
  stages,
  deals,
  contacts,
  companies,
}: {
  stages: CrmStage[];
  deals: CrmDealJoined[];
  contacts: { id: string; first_name: string | null; last_name: string | null; email: string | null }[];
  companies: Opt[];
}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [localDeals, setLocalDeals] = useState(deals);
  const [lostMove, setLostMove] = useState<{ dealId: string; stageId: string; stageName: string } | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [lostError, setLostError] = useState("");

  // Re-sync the board whenever the server prop changes (e.g. after a successful
  // move's router.refresh, or another edit) so optimistic state never drifts.
  useEffect(() => setLocalDeals(deals), [deals]);

  const byStage = (stageId: string) => localDeals.filter((d) => d.stage_id === stageId);

  function applyMove(id: string, stageId: string, lost_reason?: string) {
    const snapshot = localDeals; // revert target if the move fails
    setLocalDeals((prev) => prev.map((d) => (d.id === id ? { ...d, stage_id: stageId } : d)));
    start(async () => {
      const res = await moveDealStage(id, stageId, lost_reason);
      if (!res.ok) {
        setLocalDeals(snapshot);
        if (lost_reason !== undefined) setLostError(res.error);
      } else {
        setLostMove(null);
        setLostReason("");
        setLostError("");
      }
      router.refresh();
    });
  }

  function drop(stageId: string) {
    setOverStage(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const deal = localDeals.find((d) => d.id === id);
    if (!deal || deal.stage_id === stageId) return;
    const stage = stages.find((s) => s.id === stageId);
    if (stage?.is_lost) {
      setLostError("");
      setLostReason("");
      setLostMove({ dealId: id, stageId, stageName: stage.name });
      return;
    }
    applyMove(id, stageId);
  }

  function confirmLost() {
    if (!lostMove) return;
    if (!lostReason.trim()) {
      setLostError("Lost reason is required.");
      return;
    }
    applyMove(lostMove.dealId, lostMove.stageId, lostReason.trim());
  }

  const stageTotal = (stageId: string) =>
    byStage(stageId).reduce((a, d) => a + (Number(d.value) || 0), 0);

  return (
    <>
      <div className="mt-6 flex justify-end">
        <Button onClick={() => setShowNew(true)}>+ New deal</Button>
      </div>
      <div className="mt-4 flex gap-4 overflow-x-auto pb-4">
        {stages.map((s) => (
          <div
            key={s.id}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStage(s.id);
            }}
            onDrop={() => drop(s.id)}
            className={`flex w-72 shrink-0 flex-col rounded-2xl border bg-paper-soft/60 p-3 ${
              overStage === s.id ? "border-brand-700" : "border-line"
            }`}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-sm font-bold text-ink">{s.name}</span>
              <span className="text-xs text-muted-soft">{formatCurrency(stageTotal(s.id))}</span>
            </div>
            <div className="flex flex-col gap-2">
              {byStage(s.id).map((d) => (
                <div
                  key={d.id}
                  draggable
                  onDragStart={() => setDragId(d.id)}
                  className="cursor-grab rounded-xl border border-line bg-white p-3 ring-soft active:cursor-grabbing"
                >
                  <p className="text-sm font-semibold text-ink">{d.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {d.company?.name ?? (d.contact ? contactName(d.contact) : "—")}
                  </p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-sm font-bold text-ink">{formatCurrency(Number(d.value))}</span>
                    {d.contact ? (
                      <Link
                        href={`/portal/crm/contacts/${d.contact.id}`}
                        className="text-xs text-brand-700 hover:underline"
                      >
                        open
                      </Link>
                    ) : null}
                  </div>
                </div>
              ))}
              {byStage(s.id).length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-muted-soft">Drop deals here</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <NewDealModal
        open={showNew}
        onClose={() => setShowNew(false)}
        stages={stages}
        contacts={contacts}
        companies={companies}
      />

      <Modal
        open={!!lostMove}
        onClose={() => {
          setLostMove(null);
          setLostReason("");
          setLostError("");
        }}
        title={lostMove ? `Mark as ${lostMove.stageName}` : "Lost reason"}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">Why was this deal lost? Required before it can move to Lost.</p>
          <Field label="Lost reason">
            <TextArea
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="e.g. Chose another vendor, budget cut, went dark…"
            />
          </Field>
          <ErrorText>{lostError}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setLostMove(null);
                setLostReason("");
                setLostError("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={confirmLost} disabled={!lostReason.trim()}>
              Move to Lost
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function NewDealModal({
  open,
  onClose,
  stages,
  contacts,
  companies,
}: {
  open: boolean;
  onClose: () => void;
  stages: CrmStage[];
  contacts: { id: string; first_name: string | null; last_name: string | null; email: string | null }[];
  companies: Opt[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    title: "",
    value: "",
    value_type: "one_time",
    stage_id: stages[0]?.id ?? "",
    contact_id: "",
    company_id: "",
    expected_close: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    setError("");
    start(async () => {
      const res = await createDeal({
        title: form.title,
        value: Number(form.value) || 0,
        value_type: form.value_type,
        stage_id: form.stage_id || null,
        contact_id: form.contact_id || null,
        company_id: form.company_id || null,
        expected_close: form.expected_close || null,
      });
      if (!res.ok) return setError(res.error);
      setForm((f) => ({ ...f, title: "", value: "", contact_id: "", company_id: "", expected_close: "" }));
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="New deal">
      <div className="flex flex-col gap-3">
        <Field label="Title">
          <TextInput value={form.title} onChange={set("title")} placeholder="e.g. Semper Fi — Scale engagement" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Value ($)">
            <TextInput type="number" value={form.value} onChange={set("value")} />
          </Field>
          <Field label="Type">
            <Select value={form.value_type} onChange={set("value_type")}>
              <option value="one_time">One-time</option>
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </Select>
          </Field>
        </div>
        <Field label="Stage">
          <Select value={form.stage_id} onChange={set("stage_id")}>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact">
            <Select value={form.contact_id} onChange={set("contact_id")}>
              <option value="">—</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {contactName(c)}
                </option>
              ))}
            </Select>
          </Field>
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
        </div>
        <Field label="Expected close">
          <TextInput type="date" value={form.expected_close} onChange={set("expected_close")} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !form.title.trim()}>
            {pending ? "Saving…" : "Create deal"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
