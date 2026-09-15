"use client";

import type React from "react";
import { site } from "@/lib/site";
import { formatBytes } from "@/lib/format";
import type { ClientDocument } from "@/lib/types";
import type { EsignTypeSummary, FieldKind, PreparedSource } from "@/lib/esign/types";
import type { DraftField } from "@/lib/esign/detect-fields";
import type { WizardRecipients } from "@/components/portal/documents/wizard-recipients-step";

// Step 3 of the send wizard: a read-only summary of exactly what Send creates.

function countKinds(fields: DraftField[], key: string): Record<FieldKind, number> {
  const out: Record<FieldKind, number> = { signature: 0, date_signed: 0, printed_name: 0 };
  for (const f of fields) if (f.recipientKey === key) out[f.kind]++;
  return out;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function ReviewStep({
  doc,
  type,
  recipients,
  source,
  fields,
  engagementLabel,
  supersede,
  onSupersedeChange,
  warnings,
  sending,
}: {
  doc: ClientDocument;
  type: EsignTypeSummary;
  recipients: WizardRecipients;
  source: PreparedSource;
  fields: DraftField[];
  engagementLabel: string | null;
  supersede: boolean;
  onSupersedeChange: (b: boolean) => void;
  warnings: string[];
  sending: boolean;
}): React.JSX.Element {
  const sequential = recipients.routing === "sequential";
  const row = "grid grid-cols-[8rem_1fr] gap-3 py-2";

  return (
    <div className="space-y-5">
      <dl className="divide-y divide-line rounded-xl border border-line bg-white px-4 text-sm">
        <div className={row}>
          <dt className="text-muted">Document</dt>
          <dd className="min-w-0 break-words text-ink">
            {doc.title ?? doc.file_name}
            {doc.title ? <span className="block text-xs text-muted-soft">{doc.file_name}</span> : null}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted">Type</dt>
          <dd className="text-ink">{type.label}</dd>
        </div>
        <div className={row}>
          <dt className="text-muted">Engagement</dt>
          <dd className="text-ink">
            {engagementLabel ?? "None"}
            {engagementLabel && type.activatesEngagement ? (
              <span className="block text-xs text-muted-soft">
                Completing this marks the engagement Active if it is awaiting signature.
              </span>
            ) : null}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted">How it&apos;s signed</dt>
          <dd className="text-ink">
            {source.mode === "pdf" ? (
              "On the document's pages, in the boxes you placed."
            ) : source.mode === "image_pdf" ? (
              "The image is placed on a Letter page; signers sign in the boxes you placed."
            ) : (
              <>
                On a certificate page bound to this exact file. The file is attached to the sealed copy.
                <span className="block text-xs text-muted-soft">
                  {source.extension.replace(/^\./, "").toUpperCase()} · {formatBytes(source.byteSize)}
                </span>
              </>
            )}
            <span className="block break-all font-mono text-[11px] text-muted-soft">SHA-256 {source.sha256}</span>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted">Links</dt>
          <dd className="text-ink">
            Expire in {plural(type.expiryDays, "day")} · SMS code {type.requireSmsOtp ? "on" : "off"} · emailed from{" "}
            {site.name}
          </dd>
        </div>
      </dl>

      <div>
        <h3 className="text-sm font-medium text-ink">
          {sequential ? "Signers, in order" : "Signers, all at once"}
        </h3>
        <ol className="mt-2 space-y-1.5">
          {recipients.list.map((r, i) => {
            const counts = countKinds(fields, r.key);
            return (
              <li key={r.key} className="flex items-start gap-3 rounded-lg border border-line bg-white px-3 py-2 text-sm">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-paper-soft text-xs font-semibold text-ink">
                  {sequential ? r.order : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">
                    {r.displayName}
                    <span className="font-normal text-muted">
                      {r.kind === "staff" ? " · GBTN countersigner" : r.kind === "outside" ? " · outside signer" : ""}
                    </span>
                  </p>
                  <p className="break-all text-xs text-muted">{r.email}</p>
                  <p className="mt-0.5 text-xs text-muted-soft">
                    {source.mode === "certificate"
                      ? "Signature, printed name and date on the certificate page"
                      : [
                          plural(counts.signature, "signature box"),
                          counts.printed_name ? plural(counts.printed_name, "name box") : null,
                          counts.date_signed ? plural(counts.date_signed, "date box") : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                    {sequential && i > 0 ? " · emailed when it's their turn" : ""}
                    {r.kind === "staff" ? " · must be signed in to the portal to sign" : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {engagementLabel ? (
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={supersede}
            onChange={(e) => onSupersedeChange(e.target.checked)}
            disabled={sending}
            className="mt-1"
          />
          <span>
            Mark other unsigned {type.label} documents on this engagement as Superseded
            <span className="block text-xs text-muted-soft">
              They&apos;re restored if this envelope is voided, declined or expires.
            </span>
          </span>
        </label>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
