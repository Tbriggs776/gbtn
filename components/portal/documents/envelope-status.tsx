"use client";

import type React from "react";
import { relativeTime } from "@/lib/format";
import { Pill } from "@/components/portal/home/section";
import {
  RECIPIENT_ACTIVE_STATUSES,
  canActivateRecipient,
  effectiveEnvelopeStatus,
  envelopeStatusLabel,
  envelopeStatusTone,
  recipientStatusLabel,
  recipientStatusTone,
  type EnvelopeSummary,
  type RecipientSummary,
} from "@/lib/esign/types";

// Staff-only view of one envelope's roster. Everything here is display: the
// Resend / Send link now buttons call back into DocumentManager, which runs
// the server action (the engine decides activate vs rotate from the live row).

function kindSuffix(r: RecipientSummary): string {
  if (r.kind === "staff") return " (GBTN)";
  if (r.kind === "outside") return " (outside)";
  return "";
}

function firstName(name: string): string {
  const n = name.trim();
  return n ? n.split(/\s+/)[0] : "Signer";
}

/** Recipients the envelope is waiting on right now (sequential: the lowest unsigned order). */
export function waitingOn(envelope: EnvelopeSummary): RecipientSummary[] {
  const unsigned = envelope.recipients.filter((r) => r.status !== "signed");
  if (envelope.routing !== "sequential" || unsigned.length === 0) return unsigned;
  const lowest = Math.min(...unsigned.map((r) => r.order));
  return unsigned.filter((r) => r.order === lowest);
}

/**
 * The compact per-signer line for the documents table:
 * `1 Jane ✓ · 2 Bob · 3 Tyler (GBTN)`, each name titled with its status.
 */
export function EnvelopeSignerLine({
  envelope,
  now,
}: {
  envelope: EnvelopeSummary;
  now: Date;
}): React.JSX.Element | null {
  if (envelope.recipients.length === 0) return null;
  const eff = effectiveEnvelopeStatus(envelope, now);
  const waiting = eff === "in_progress" && envelope.routing === "sequential" ? waitingOn(envelope) : [];
  return (
    <p className="mt-1 text-xs text-muted" suppressHydrationWarning>
      {envelope.recipients.map((r, i) => (
        <span
          key={r.id}
          title={`${r.name} · ${recipientStatusLabel(r.status)}${
            r.signedAt ? ` · signed ${relativeTime(r.signedAt)}` : ""
          }`}
        >
          {i > 0 ? " · " : ""}
          {envelope.routing === "sequential" ? `${r.order} ` : ""}
          <span className={r.status === "signed" ? "text-ink" : undefined}>
            {firstName(r.name)}
            {kindSuffix(r)}
          </span>
          {r.status === "signed" ? " ✓" : r.status === "declined" ? " ✗" : ""}
        </span>
      ))}
      {waiting.length > 0 ? (
        <span className="text-muted-soft"> · waiting on {waiting.map((r) => firstName(r.name)).join(", ")}</span>
      ) : null}
    </p>
  );
}

export function EnvelopeStatus({
  envelope,
  now,
  pending,
  onResend,
  onActivate,
}: {
  envelope: EnvelopeSummary;
  now: Date;
  pending: boolean;
  onResend: (recipientId: string) => void;
  onActivate: (recipientId: string) => void;
}): React.JSX.Element {
  const eff = effectiveEnvelopeStatus(envelope, now);
  const open = eff === "in_progress";
  const active: readonly string[] = RECIPIENT_ACTIVE_STATUSES;

  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted" suppressHydrationWarning>
        <Pill tone={envelopeStatusTone(eff)}>{envelopeStatusLabel(eff)}</Pill>
        <span>{envelope.routing === "sequential" ? "Signing in order" : "Everyone at once"}</span>
        <span>· sent {relativeTime(envelope.sentAt)}</span>
        {open ? <span>· expires {relativeTime(envelope.expiresAt)}</span> : null}
        {envelope.completedAt ? <span>· completed {relativeTime(envelope.completedAt)}</span> : null}
        {eff === "completing" && envelope.completingAt ? (
          <span>· everyone signed {relativeTime(envelope.completingAt)}</span>
        ) : null}
        {eff === "completing" && envelope.sealAttempts > 0 ? (
          <span>
            · {envelope.sealAttempts} failed sealing attempt{envelope.sealAttempts === 1 ? "" : "s"}
            {envelope.sealNextAttemptAt ? `, next retry ${relativeTime(envelope.sealNextAttemptAt)}` : ""}
          </span>
        ) : null}
        {envelope.sourceMode === "certificate" ? <span>· certificate page</span> : null}
      </div>

      {envelope.recipients.length === 0 ? (
        <p className="mt-3 text-xs text-muted">No signers on record.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {envelope.recipients.map((r) => {
            const canResend = open && active.includes(r.status);
            const canActivate = open && canActivateRecipient(envelope, r.id);
            return (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {envelope.routing === "sequential" ? (
                      <span className="mr-1.5 text-muted-soft">{r.order}.</span>
                    ) : null}
                    {r.name}
                    <span className="font-normal text-muted">{kindSuffix(r)}</span>
                  </p>
                  <p className="break-all text-xs text-muted">{r.email}</p>
                  <p className="mt-0.5 text-xs text-muted-soft" suppressHydrationWarning>
                    {[
                      r.activatedAt ? `link sent ${relativeTime(r.activatedAt)}` : null,
                      r.viewedAt ? `viewed ${relativeTime(r.viewedAt)}` : null,
                      r.signedAt ? `signed ${relativeTime(r.signedAt)}` : null,
                      r.method ? (r.method === "typed" ? "typed signature" : "drawn signature") : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || (r.status === "pending" ? "Link goes out when it's their turn" : "")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Pill tone={recipientStatusTone(r.status)}>{recipientStatusLabel(r.status)}</Pill>
                  {canResend ? (
                    <button
                      type="button"
                      onClick={() => onResend(r.id)}
                      disabled={pending}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                    >
                      Resend
                    </button>
                  ) : null}
                  {canActivate ? (
                    <button
                      type="button"
                      onClick={() => onActivate(r.id)}
                      disabled={pending}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                    >
                      Send link now
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
