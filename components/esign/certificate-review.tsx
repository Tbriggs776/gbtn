"use client";

import { useState } from "react";
import type React from "react";
import type { AdoptedSignature } from "@/components/esign/adopt-signature-modal";
import {
  DocumentFieldsView,
  ESIGN_CARD,
  ESIGN_EYEBROW,
  ESIGN_SECONDARY_BTN,
  postEsign,
} from "@/components/esign/document-fields-view";
import { formatBytes } from "@/lib/format";
import type { SigningView } from "@/lib/esign/types";

// Certificate mode: the original (Word, Excel, text…) can't carry signature
// boxes, so the signer downloads and reads the frozen original, then signs a
// generated signature page bound to its SHA-256. The original is only ever
// served as an attachment download (I48), never rendered here. The signature
// page renders through the same sandboxed viewer as a PDF.

type OpenView = Extract<SigningView, { state: "open" }>;

const TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG image",
  "image/jpeg": "JPEG image",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel workbook",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint presentation",
  "text/plain": "Text file",
  "text/csv": "CSV file",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-ink sm:text-right">{children}</dd>
    </div>
  );
}

/** The original's identity plus Download original. Also used by the parent's fallback. */
export function OriginalFileCard({
  view,
  token,
  onOriginalOpened,
}: {
  view: OpenView;
  token: string;
  onOriginalOpened: () => void;
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const original = view.original;
  if (!original) return null;

  function download() {
    if (busy) return;
    // Open the tab inside the click so popup blockers (iOS Safari especially)
    // allow it, then point it at the freshly minted 60-second download URL.
    let tab: Window | null = null;
    try {
      tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
    } catch {
      tab = null;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const r = await postEsign({ action: "original_url", token });
        if (!r.ok) {
          tab?.close();
          setError(
            r.error.code === "expired"
              ? "This signing link has expired."
              : r.error.message || "We couldn't open the original. Try again."
          );
          return;
        }
        setOpened(true);
        onOriginalOpened();
        if (tab) tab.location.replace(r.data.url);
        else window.location.assign(r.data.url);
      } catch {
        tab?.close();
        setError("We couldn't open the original. Try again.");
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <section className={ESIGN_CARD}>
      <h2 className={ESIGN_EYEBROW}>The document</h2>
      <p className="mt-2 text-sm text-muted">
        This file can&apos;t carry signature boxes. Download and read the original,
        then sign the signature page below. The page is bound to this exact file by
        its fingerprint, and the file is attached to the sealed copy.
      </p>
      <dl className="mt-4 divide-y divide-line border-t border-line text-sm">
        <Row label="File">
          <span className="break-all">{original.fileName}</span>
        </Row>
        <Row label="Type">{TYPE_LABELS[original.contentType] ?? original.contentType}</Row>
        <Row label="Size">{formatBytes(original.byteSize)}</Row>
        <Row label="Fingerprint">
          <span className="break-all font-mono text-xs">SHA-256 {original.sha256}</span>
        </Row>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <button type="button" onClick={download} disabled={busy} className={ESIGN_SECONDARY_BTN}>
          {busy ? "Preparing…" : "Download original"}
        </button>
        {!opened ? (
          <p className="text-xs text-muted-soft">You haven&apos;t opened the original yet.</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function CertificateReview({
  view,
  token,
  adopted,
  appliedFieldIds,
  onFieldActivate,
  onOriginalOpened,
  onFallback,
}: {
  view: OpenView;
  token: string;
  adopted: AdoptedSignature | null;
  appliedFieldIds: ReadonlySet<string>;
  onFieldActivate: (fieldId: string) => void;
  onOriginalOpened: () => void;
  onFallback: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-4 sm:space-y-5">
      <OriginalFileCard view={view} token={token} onOriginalOpened={onOriginalOpened} />
      <section className="rounded-2xl border border-line bg-white p-3 sm:p-6">
        <h2 className={`${ESIGN_EYEBROW} px-2 pt-2 sm:p-0`}>Signature page</h2>
        <div className="mt-3 px-1 sm:px-0">
          <DocumentFieldsView
            view={view}
            token={token}
            adopted={adopted}
            appliedFieldIds={appliedFieldIds}
            onFieldActivate={onFieldActivate}
            onFallback={onFallback}
          />
        </div>
      </section>
    </div>
  );
}
