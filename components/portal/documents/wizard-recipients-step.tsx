"use client";

import type React from "react";
import { useRef, useState } from "react";
import {
  MAX_RECIPIENTS,
  type EsignContactOption,
  type EsignStaffData,
  type EsignTypeSummary,
  type RoutingMode,
  type SendRecipientInput,
  type StaffSignerOption,
} from "@/lib/esign/types";

// Step 1 of the send wizard: who signs, and in what order. The server
// re-validates all of it (sendEnvelopeSchema, then esign_create_envelope);
// recipientsProblems mirrors those rules so staff aren't sent back from Send.

export type WizardRecipients = {
  routing: RoutingMode;
  list: (SendRecipientInput & { displayName: string; email: string })[];
};
export type WizardRecipient = WizardRecipients["list"][number];
/** Omit that distributes over the recipient union (plain Omit collapses it to the shared keys). */
type NewRecipient = WizardRecipient extends infer T ? (T extends unknown ? Omit<T, "key" | "order"> : never) : never;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INPUT =
  "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:opacity-60";

export function maxSigners(type: EsignTypeSummary): number {
  return Math.max(1, Math.min(type.maxRecipients, MAX_RECIPIENTS));
}

/** Parallel: every order is 1. Sequential: 1..n in list order. */
export function withOrders(list: WizardRecipient[], routing: RoutingMode): WizardRecipient[] {
  return list.map((r, i) => ({ ...r, order: routing === "parallel" ? 1 : i + 1 }));
}

/** The lowest unused r1…r10 key (keys must match /^r\d{1,2}$/). */
function nextKey(list: WizardRecipient[]): string | null {
  const used = new Set(list.map((r) => r.key));
  for (let i = 1; i <= MAX_RECIPIENTS; i++) {
    if (!used.has(`r${i}`)) return `r${i}`;
  }
  return null;
}

/**
 * Mirrors toE164 (lib/crm/twilio.ts, server-only), which the send runs on every
 * signer's phone: fewer than 8 digits normalizes to null and a type that sends
 * an SMS code then refuses the whole envelope with phone_required.
 */
export function hasSmsNumber(raw: string | null | undefined): boolean {
  return (raw ?? "").replace(/\D/g, "").length >= 8;
}

/** GBTN countersigners carry no phone on the envelope, so an SMS-code type always refuses them. */
export const STAFF_SMS_PROBLEM =
  "GBTN countersigners have no mobile number on file, and this type sends an SMS code. Remove the countersigner or choose a type without SMS codes.";

function contactProblem(c: EsignContactOption, type: EsignTypeSummary): string | null {
  if (!c.email) return "no email on file";
  if (type.requireSmsOtp && !hasSmsNumber(c.phone)) {
    return c.phone
      ? "a mobile number that can't receive an SMS code (this type sends one)"
      : "no mobile number on file (this type sends an SMS code)";
  }
  return null;
}

function staffLabel(s: StaffSignerOption): string {
  return `${s.name} · ${s.email}`;
}

/** Per-recipient problems keyed by recipient key, plus envelope-level ones under "". */
export function recipientsProblems(
  value: WizardRecipients,
  staff: EsignStaffData,
  type: EsignTypeSummary
): Record<string, string> {
  const out: Record<string, string> = {};
  const list = value.list;
  if (list.length === 0) out[""] = "Add at least one signer.";
  else if (list.length > maxSigners(type)) out[""] = `This document type allows up to ${maxSigners(type)} signers.`;
  if (list.filter((r) => r.kind === "staff").length > 1) out[""] = "Add at most one GBTN countersigner.";

  const seenEmails = new Map<string, string>();
  const seenContacts = new Set<string>();
  for (const r of list) {
    let problem: string | null = null;
    if (r.kind === "client_contact") {
      const c = staff.contacts.find((x) => x.id === r.contactId);
      if (!c) problem = "That contact is no longer on file.";
      else {
        const p = contactProblem(c, type);
        if (p) problem = `This contact has ${p}.`;
      }
      if (!problem && seenContacts.has(r.contactId)) problem = "This contact is already a signer.";
      seenContacts.add(r.contactId);
    } else if (r.kind === "outside") {
      if (!type.allowOutsideSigners) problem = "This document type doesn't allow outside signers.";
      else if (r.fullName.trim().length < 2) problem = "Enter the signer's full name.";
      else if (r.fullName.trim().length > 120) problem = "Keep the name under 120 characters.";
      else if (!EMAIL_RE.test(r.email.trim()) || r.email.trim().length > 254) problem = "Enter a valid email address.";
      else if (type.requireSmsOtp && !hasSmsNumber(r.phone))
        problem = "A mobile number (at least 8 digits) is required because this type sends an SMS code.";
      else if ((r.phone ?? "").trim().length > 32) problem = "Check the mobile number.";
    } else if (!staff.staffSigners.some((s) => s.userId === r.staffUserId)) {
      problem = "That countersigner isn't available.";
    } else if (type.requireSmsOtp) {
      problem = STAFF_SMS_PROBLEM;
    }

    const email = r.email.trim().toLowerCase();
    if (!problem && email) {
      const other = seenEmails.get(email);
      if (other !== undefined) problem = `Same email as ${other}. Each signer needs a unique email.`;
      else seenEmails.set(email, r.displayName || email);
    }
    if (problem) out[r.key] = problem;
  }
  return out;
}

export function RecipientsStep({
  staff,
  type,
  value,
  onChange,
  disabled,
}: {
  staff: EsignStaffData;
  type: EsignTypeSummary;
  value: WizardRecipients;
  onChange: (v: WizardRecipients) => void;
  disabled: boolean;
}): React.JSX.Element {
  const [staffPick, setStaffPick] = useState<string>(() => staff.staffSigners[0]?.userId ?? "");
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [announce, setAnnounce] = useState("");
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [dragging, setDragging] = useState<{ from: number; over: number; pointerId: number } | null>(null);

  const sequential = value.routing === "sequential";
  const cap = maxSigners(type);
  const full = value.list.length >= cap;
  const problems = recipientsProblems(value, staff, type);
  const hasStaff = value.list.some((r) => r.kind === "staff");

  function setList(list: WizardRecipient[]) {
    onChange({ routing: value.routing, list: withOrders(list, value.routing) });
  }

  function setRouting(routing: RoutingMode) {
    onChange({ routing, list: withOrders(value.list, routing) });
  }

  function add(r: NewRecipient) {
    const key = nextKey(value.list);
    if (!key || full) return;
    setList([...value.list, { ...r, key, order: 1 } as WizardRecipient]);
  }

  function remove(key: string) {
    setList(value.list.filter((r) => r.key !== key));
  }

  function update(key: string, patch: { fullName?: string; email?: string; phone?: string }) {
    setList(
      value.list.map((r) => {
        if (r.key !== key || r.kind !== "outside") return r;
        const next = { ...r, ...patch };
        return { ...next, displayName: next.fullName, email: next.email };
      })
    );
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= value.list.length || from === to) return;
    const list = [...value.list];
    const [row] = list.splice(from, 1);
    list.splice(to, 0, row);
    setList(list);
    setAnnounce(`${row.displayName || "Signer"} moved to position ${to + 1} of ${list.length}.`);
  }

  function overIndex(clientY: number): number {
    const rows = rowRefs.current.slice(0, value.list.length);
    for (let i = 0; i < rows.length; i++) {
      const el = rows[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return Math.max(0, rows.length - 1);
  }

  const availableContacts = staff.contacts.filter(
    (c) => !value.list.some((r) => r.kind === "client_contact" && r.contactId === c.id)
  );

  return (
    <div className="space-y-5">
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>

      {/* Routing */}
      <div>
        <span className="block text-sm font-medium text-ink">Signing order</span>
        <div className="mt-1 inline-flex rounded-full border border-line bg-paper-soft p-0.5" role="radiogroup" aria-label="Signing order">
          {(
            [
              { v: "parallel", label: "Everyone at once" },
              { v: "sequential", label: "In order" },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={value.routing === o.v}
              disabled={disabled}
              onClick={() => setRouting(o.v)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60 ${
                value.routing === o.v ? "bg-white text-ink ring-soft" : "text-muted hover:text-ink"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted-soft">
          {sequential
            ? "Each signer gets their link after the one before them signs. Drag rows, or focus a row and press Alt+↑/↓."
            : "Every signer gets a link now. The document completes when the last one signs."}
        </p>
      </div>

      {/* Signers */}
      <div>
        <span className="block text-sm font-medium text-ink">
          Signers <span className="font-normal text-muted-soft">({value.list.length} of up to {cap})</span>
        </span>
        {value.list.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted">
            Add a client contact, an outside signer or a GBTN countersigner below.
          </p>
        ) : (
          <ol className="mt-2 space-y-2">
            {value.list.map((r, i) => {
              const problem = problems[r.key];
              const showProblem = problem && (r.kind !== "outside" || touched.has(r.key));
              const isDragged = dragging?.from === i;
              const isOver = dragging !== null && dragging.over === i && dragging.from !== i;
              return (
                <li
                  key={r.key}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  tabIndex={sequential ? 0 : -1}
                  aria-label={sequential ? `Signer ${i + 1}: ${r.displayName || "unnamed"}` : undefined}
                  onKeyDown={(e) => {
                    if (!sequential || disabled || e.target !== e.currentTarget) return;
                    if (e.altKey && e.key === "ArrowUp") {
                      e.preventDefault();
                      move(i, i - 1);
                    } else if (e.altKey && e.key === "ArrowDown") {
                      e.preventDefault();
                      move(i, i + 1);
                    }
                  }}
                  className={`rounded-lg border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-brand-200 ${
                    isOver ? "border-brand-400 bg-brand-50/50" : "border-line bg-white"
                  } ${isDragged ? "opacity-60" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    {sequential ? (
                      <div className="flex shrink-0 items-center gap-1 pt-0.5">
                        <span
                          aria-hidden="true"
                          title="Drag to reorder"
                          onPointerDown={(e) => {
                            if (disabled || e.button !== 0) return;
                            e.preventDefault();
                            try {
                              e.currentTarget.setPointerCapture(e.pointerId);
                            } catch {
                              // best-effort
                            }
                            setDragging({ from: i, over: i, pointerId: e.pointerId });
                          }}
                          onPointerMove={(e) => {
                            if (!dragging || dragging.pointerId !== e.pointerId) return;
                            const over = overIndex(e.clientY);
                            if (over !== dragging.over) setDragging({ ...dragging, over });
                          }}
                          onPointerUp={(e) => {
                            if (!dragging || dragging.pointerId !== e.pointerId) return;
                            const { from, over } = dragging;
                            setDragging(null);
                            move(from, over);
                          }}
                          onPointerCancel={() => setDragging(null)}
                          className="cursor-grab touch-none rounded px-1 text-muted-soft hover:text-ink"
                        >
                          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
                            <circle cx="5.5" cy="4" r="1.2" />
                            <circle cx="10.5" cy="4" r="1.2" />
                            <circle cx="5.5" cy="8" r="1.2" />
                            <circle cx="10.5" cy="8" r="1.2" />
                            <circle cx="5.5" cy="12" r="1.2" />
                            <circle cx="10.5" cy="12" r="1.2" />
                          </svg>
                        </span>
                        <span className="grid h-6 w-6 place-items-center rounded-full bg-paper-soft text-xs font-semibold text-ink">
                          {i + 1}
                        </span>
                      </div>
                    ) : null}

                    <div className="min-w-0 flex-1">
                      {r.kind === "outside" ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <p className="text-xs font-medium text-muted sm:col-span-2">Outside signer</p>
                          <input
                            aria-label="Full name"
                            placeholder="Full name"
                            value={r.fullName}
                            maxLength={120}
                            autoComplete="off"
                            disabled={disabled}
                            onChange={(e) => update(r.key, { fullName: e.target.value })}
                            onBlur={() => setTouched((t) => new Set(t).add(r.key))}
                            className={`${INPUT} sm:col-span-2`}
                          />
                          <input
                            aria-label="Email"
                            placeholder="Email"
                            type="email"
                            value={r.email}
                            maxLength={254}
                            autoComplete="off"
                            disabled={disabled}
                            onChange={(e) => update(r.key, { email: e.target.value })}
                            onBlur={() => setTouched((t) => new Set(t).add(r.key))}
                            className={type.requireSmsOtp ? INPUT : `${INPUT} sm:col-span-2`}
                          />
                          {type.requireSmsOtp ? (
                            <input
                              aria-label="Mobile phone"
                              placeholder="Mobile phone"
                              type="tel"
                              value={r.phone ?? ""}
                              maxLength={32}
                              autoComplete="off"
                              disabled={disabled}
                              onChange={(e) => update(r.key, { phone: e.target.value })}
                              onBlur={() => setTouched((t) => new Set(t).add(r.key))}
                              className={INPUT}
                            />
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <p className="truncate text-sm font-medium text-ink">
                            {r.displayName || "Unnamed"}
                            <span className="font-normal text-muted">
                              {r.kind === "staff" ? " · GBTN countersigner" : " · client contact"}
                            </span>
                          </p>
                          <p className="break-all text-xs text-muted">{r.email}</p>
                        </>
                      )}
                      {showProblem ? <p className="mt-1 text-xs text-red-700">{problem}</p> : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5">
                      {sequential ? (
                        <>
                          <button
                            type="button"
                            aria-label="Move up"
                            disabled={disabled || i === 0}
                            onClick={() => move(i, i - 1)}
                            className="rounded p-1 text-muted hover:bg-paper-soft hover:text-ink disabled:opacity-30"
                          >
                            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                              <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            aria-label="Move down"
                            disabled={disabled || i === value.list.length - 1}
                            onClick={() => move(i, i + 1)}
                            className="rounded p-1 text-muted hover:bg-paper-soft hover:text-ink disabled:opacity-30"
                          >
                            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Remove ${r.displayName || "signer"}`}
                        disabled={disabled}
                        onClick={() => remove(r.key)}
                        className="rounded p-1 text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {problems[""] && value.list.length > 0 ? <p className="mt-2 text-xs text-red-700">{problems[""]}</p> : null}
      </div>

      {/* Add signers */}
      <fieldset disabled={disabled || full} className="space-y-4 rounded-xl border border-line bg-paper-soft/60 p-4">
        <legend className="px-1 text-sm font-medium text-ink">Add a signer</legend>
        {full ? <p className="text-xs text-muted">This document type allows up to {cap} signers.</p> : null}

        <div>
          <span className="block text-xs font-medium text-muted">Client contacts</span>
          {staff.contacts.length === 0 ? (
            <p className="mt-1 text-xs text-muted-soft">No contacts on file for this client.</p>
          ) : availableContacts.length === 0 ? (
            <p className="mt-1 text-xs text-muted-soft">Every contact is already a signer.</p>
          ) : (
            <ul className="mt-1 space-y-1.5">
              {availableContacts.map((c) => {
                const problem = contactProblem(c, type);
                return (
                  <li
                    key={c.id}
                    className="flex items-start justify-between gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                  >
                    <span className={`min-w-0 break-words ${problem ? "text-muted-soft" : "text-ink"}`}>
                      {[c.full_name, c.title, c.email].filter(Boolean).join(" · ")}
                      {problem ? ` (${problem})` : null}
                    </span>
                    <button
                      type="button"
                      disabled={Boolean(problem)}
                      onClick={() =>
                        add({
                          kind: "client_contact",
                          contactId: c.id,
                          displayName: c.full_name,
                          email: c.email ?? "",
                        })
                      }
                      className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-muted-soft disabled:hover:bg-transparent"
                    >
                      Add
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {type.allowOutsideSigners ? (
          <div>
            <span className="block text-xs font-medium text-muted">Someone not on file</span>
            <button
              type="button"
              onClick={() => add({ kind: "outside", fullName: "", email: "", displayName: "" })}
              className="mt-1 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
            >
              Add outside signer
            </button>
          </div>
        ) : null}

        <div>
          <span className="block text-xs font-medium text-muted">GBTN countersigner</span>
          {hasStaff ? (
            <p className="mt-1 text-xs text-muted-soft">A countersigner is already added.</p>
          ) : type.requireSmsOtp ? (
            <p className="mt-1 text-xs text-amber-800">
              This type sends an SMS code, and GBTN countersigners have no mobile number on file, so they can&apos;t
              sign it.
            </p>
          ) : staff.staffSigners.length === 0 ? (
            <p className="mt-1 text-xs text-muted-soft">No platform admins are available to countersign.</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-2">
              <select
                aria-label="GBTN countersigner"
                value={staffPick}
                onChange={(e) => setStaffPick(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
              >
                {staff.staffSigners.map((s) => (
                  <option key={s.userId} value={s.userId}>
                    {staffLabel(s)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  const s = staff.staffSigners.find((x) => x.userId === staffPick);
                  if (s) add({ kind: "staff", staffUserId: s.userId, displayName: s.name, email: s.email });
                }}
                className="shrink-0 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
              >
                Add countersigner
              </button>
            </div>
          )}
          <p className="mt-1 text-xs text-muted-soft">
            Countersigners must be signed in to the GBTN portal in the browser they sign from.
          </p>
        </div>
      </fieldset>
    </div>
  );
}
