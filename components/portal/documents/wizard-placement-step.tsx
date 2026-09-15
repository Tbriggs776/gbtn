"use client";

import type React from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { site } from "@/lib/site";
import { MAX_FIELDS, PPM, type FieldKind, type PreparedSource, type SnapshotPage } from "@/lib/esign/types";
import {
  DEFAULT_FIELD_PT,
  clampField,
  displayDims,
  fieldPercentStyle,
  geometrySelfCheck,
  pageBox,
  pageFromPdfjs,
  pagesAgree,
  ptToPpm,
  validateField,
} from "@/lib/esign/geometry";
import {
  detectFields,
  selectDetectionPages,
  type DetectPage,
  type DraftField,
  type DraftRecipient,
} from "@/lib/esign/detect-fields";
import { PdfSandbox, fetchVerified } from "@/components/esign/pdf-sandbox";
import { PdfPages, type PageSize } from "@/components/esign/pdf-pages";
import { FieldBox, KIND_LABELS } from "@/components/portal/documents/field-box";

// Step 2 of the send wizard: staff see the exact bytes that will be frozen and
// place each signer's boxes on them.
//
// Security (S9): this component never parses a PDF. pdf.js runs only inside
// PdfSandbox's opaque-origin iframe; here we fetch the short-lived signed URL,
// verify its SHA-256 against what the server hashed, hand the bytes over, and
// get back page geometry, plain text items and bitmaps. Images are shown from
// a blob: URL of the same verified bytes, never from a second fetch.
//
// Correctness (C16): staff place boxes in pdf.js's page frame, but the snapshot
// is built from pdf-lib's reading of the file. The two must agree on every
// page box to the millipoint, or sending is blocked.

type PlacedSource = Extract<PreparedSource, { mode: "pdf" | "image_pdf" }>;

type LoadState =
  | { phase: "loading" }
  | { phase: "ready" }
  | { phase: "error"; kind: "generic" | "assets" | "pages" };

const DETECT_BUDGET_MS = 4_000;
const PDF_MAX_BYTES = 15_000_000;

/** Tailwind can't generate per-signer classes (and legacy teal/cyan render crimson), so inline styles. */
export const SIGNER_COLORS = [
  "#16335b",
  "#9e2335",
  "#2f6f4e",
  "#8a5a00",
  "#5b3f8c",
  "#006b75",
  "#7a4b2a",
  "#3d5a80",
] as const;

export function signerColor(index: number): string {
  const n = SIGNER_COLORS.length;
  return SIGNER_COLORS[((index % n) + n) % n];
}

export function pageSizeOf(p: SnapshotPage): PageSize {
  const { box, r } = pageBox(p);
  const { vw, vh } = displayDims(box, r);
  return { index: p.index, vw, vh };
}

export function placedSourcePages(source: PlacedSource): SnapshotPage[] {
  return source.mode === "pdf" ? source.pages : [source.page];
}

/** null when the placement can be sent; otherwise the first blocking reason. */
export function placementGate(
  fields: readonly DraftField[],
  recipients: readonly DraftRecipient[],
  pages: readonly SnapshotPage[]
): string | null {
  if (recipients.length === 0) return "Add a signer first.";
  if (fields.length > MAX_FIELDS) return `An envelope can carry at most ${MAX_FIELDS} boxes.`;
  const keys = new Set(recipients.map((r) => r.key));
  const byIndex = new Map(pages.map((p) => [p.index, p] as const));
  for (const f of fields) {
    if (!keys.has(f.recipientKey)) return "A box belongs to a signer who was removed. Delete it.";
    const page = byIndex.get(f.page);
    const reason = page ? validateField(f, page, pages.length) : "it is on a page that doesn't exist";
    if (reason) return `${KIND_LABELS[f.kind]} box on page ${f.page + 1}: ${reason}`;
  }
  const missing = recipients.filter(
    (r) => !fields.some((f) => f.recipientKey === r.key && f.kind === "signature" && f.required)
  );
  if (missing.length > 0) {
    return `Add a required signature box for ${missing.map((r) => r.name || "each signer").join(", ")}.`;
  }
  return null;
}

/** Things worth a second look that don't block sending. */
export function placementWarnings(fields: readonly DraftField[], recipients: readonly DraftRecipient[]): string[] {
  const out: string[] = [];
  const nameOf = (key: string) => recipients.find((r) => r.key === key)?.name || "a signer";

  for (const key of new Set(fields.filter((f) => f.warn === "fallback").map((f) => f.recipientKey))) {
    out.push(`No signature line found for ${nameOf(key)} — check the placement.`);
  }
  const toCheck = fields.filter((f) => f.warn === "check_detected").length;
  if (toCheck > 0) {
    out.push(
      `${toCheck} detected date or name box${toCheck === 1 ? "" : "es"} still marked "Check this box".`
    );
  }
  let overlaps = 0;
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const a = fields[i];
      const b = fields[j];
      if (a.page !== b.page || a.recipientKey === b.recipientKey) continue;
      const ix = Math.min(a.x_ppm + a.w_ppm, b.x_ppm + b.w_ppm) - Math.max(a.x_ppm, b.x_ppm);
      const iy = Math.min(a.y_ppm + a.h_ppm, b.y_ppm + b.h_ppm) - Math.max(a.y_ppm, b.y_ppm);
      if (ix > 0 && iy > 0) overlaps++;
    }
  }
  if (overlaps > 0) {
    out.push(`${overlaps} box${overlaps === 1 ? " overlaps" : "es overlap"} another signer's box.`);
  }
  const low = fields.filter((f) => f.y_ppm + f.h_ppm > PPM * 0.96).length;
  if (low > 0) {
    out.push(
      `${low} box${low === 1 ? " sits" : "es sit"} in the bottom 4% of a page, where the sealed copy's footer is printed.`
    );
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function nextStaffKey(fields: readonly DraftField[]): string {
  let max = 0;
  for (const f of fields) {
    const m = /^s(\d+)$/.exec(f.key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `s${max + 1}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "")).toUpperCase();
}

let geometryChecked = false;

const ZOOMS = [
  { label: "Fit width", value: 1 },
  { label: "75%", value: 0.75 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2 },
] as const;

const KINDS: FieldKind[] = ["signature", "date_signed", "printed_name"];

export function PlacementStep({
  source,
  recipients,
  clientLegalName,
  fields,
  onFieldsChange,
  onVerified,
  onInvalidated,
  disabled,
  onReloadSource,
}: {
  source: PlacedSource;
  recipients: DraftRecipient[];
  clientLegalName: string;
  fields: DraftField[];
  onFieldsChange: (f: DraftField[]) => void;
  onVerified: (v: { sha256: string; pages: SnapshotPage[] }) => void;
  /**
   * The preview failed (fetch, sandbox, page-box mismatch, a page render or a
   * sandbox crash after verification). Send must stay blocked until a Retry
   * verifies the bytes again and calls onVerified.
   */
  onInvalidated?: (kind: "generic" | "assets" | "pages") => void;
  disabled: boolean;
  /** Retry re-prepares the source: the preview URL only lives 60 seconds. */
  onReloadSource?: () => void;
}): React.JSX.Element {
  const uid = useId();
  const pages = useMemo(() => placedSourcePages(source), [source]);
  const pageByIndex = useMemo(() => new Map(pages.map((p) => [p.index, p] as const)), [pages]);
  const pageSizes = useMemo(() => pages.map(pageSizeOf), [pages]);
  const pageCount = pages.length;

  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [sandbox, setSandbox] = useState<PdfSandbox | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [detecting, setDetecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [armed, setArmed] = useState<FieldKind | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [announce, setAnnounce] = useState("");

  // Latest props for async work started by an effect (detection, verification).
  const latest = useRef({ fields, onFieldsChange, onVerified, onInvalidated, recipients, clientLegalName });
  useEffect(() => {
    latest.current = { fields, onFieldsChange, onVerified, onInvalidated, recipients, clientLegalName };
  });

  // Every failure path (load effect, onCrash, PdfPages onError) lands here, so a
  // preview that dies after onVerified still takes the wizard's verification away.
  useEffect(() => {
    if (load.phase === "error") latest.current.onInvalidated?.(load.kind);
  }, [load]);

  useEffect(() => {
    if (geometryChecked || process.env.NODE_ENV === "production") return;
    geometryChecked = true;
    const failures = geometrySelfCheck();
    if (failures.length > 0) console.error("[esign] geometrySelfCheck failed", failures);
  }, []);

  const active = recipients.find((r) => r.key === activeKey) ?? recipients[0] ?? null;
  const recipientIndex = (key: string) => recipients.findIndex((r) => r.key === key);

  const runDetection = useCallback(
    async (sb: PdfSandbox, total: number) => {
      setDetecting(true);
      setNotice(null);
      try {
        const started = Date.now();
        const collected: DetectPage[] = [];
        let timedOut = false;
        for (const index of selectDetectionPages(total)) {
          const remaining = DETECT_BUDGET_MS - (Date.now() - started);
          if (remaining <= 0) {
            timedOut = true;
            break;
          }
          const page = pageByIndex.get(index);
          if (!page) continue;
          const items = await withTimeout(sb.getText(index), remaining);
          if (items === null) {
            timedOut = true;
            break;
          }
          collected.push({ page, items });
        }
        const lastPage = pageByIndex.get(total - 1) ?? pages[pages.length - 1];
        const { recipients: recs, clientLegalName: legal, fields: current, onFieldsChange: change } = latest.current;
        if (!lastPage || recs.length === 0) return;
        const result = detectFields(collected, total, {
          recipients: recs,
          clientLegalName: legal,
          providerNames: [site.name, site.legalName, site.shortName],
          lastPage,
        });
        // Re-running replaces only detected boxes; everything staff drew stays.
        change([...current.filter((f) => f.origin !== "detected"), ...result.fields]);
        setSelectedKey(null);
        setDetailsKey(null);
        setAnnounce(`Detection placed ${result.fields.length} box${result.fields.length === 1 ? "" : "es"}.`);
        if (timedOut) {
          setNotice("Detection ran out of time on this document. Check every page for missing boxes.");
        }
      } catch {
        setNotice("Signature-line detection didn't finish. Place the boxes by hand.");
      } finally {
        setDetecting(false);
      }
    },
    [pageByIndex, pages]
  );

  // Load: fetch + verify the exact bytes, then open them in the sandbox (PDF)
  // or show them from a blob: URL (image).
  useEffect(() => {
    let cancelled = false;
    let created: PdfSandbox | null = null;
    let objectUrl: string | null = null;
    let offCrash: (() => void) | null = null;
    setLoad({ phase: "loading" });
    setSandbox(null);
    setImageUrl(null);

    void (async () => {
      try {
        if (source.mode === "pdf") {
          const fetched = await fetchVerified(source.previewUrl, source.sha256, { maxBytes: PDF_MAX_BYTES });
          if (cancelled) return;
          if (!fetched.ok) {
            setLoad({ phase: "error", kind: "generic" });
            return;
          }
          const sb = await PdfSandbox.create();
          if (cancelled) {
            sb.destroy();
            return;
          }
          created = sb;
          const opened = await sb.open(fetched.bytes);
          if (cancelled) return;
          if (!opened.ok) {
            setLoad({ phase: "error", kind: opened.reason === "assets" ? "assets" : "generic" });
            return;
          }
          const mapped = opened.pages.map((p) => pageFromPdfjs(p.index, p.view, p.rotate));
          const agreed = mapped.every((m): m is SnapshotPage => m !== null) && pagesAgree(mapped, source.pages);
          if (!agreed) {
            setLoad({ phase: "error", kind: "pages" });
            return;
          }
          offCrash = sb.onCrash(() => {
            if (!cancelled) setLoad({ phase: "error", kind: "generic" });
          });
          latest.current.onVerified({ sha256: source.sha256, pages: source.pages });
          setNumPages(opened.numPages);
          setSandbox(sb);
          setLoad({ phase: "ready" });
          if (latest.current.fields.length === 0) void runDetection(sb, opened.numPages);
        } else {
          const fetched = await fetchVerified(source.previewUrl, source.sha256, { maxBytes: PDF_MAX_BYTES });
          if (cancelled) return;
          if (!fetched.ok) {
            setLoad({ phase: "error", kind: "generic" });
            return;
          }
          objectUrl = URL.createObjectURL(new Blob([fetched.bytes.slice()], { type: source.imageContentType }));
          latest.current.onVerified({ sha256: source.sha256, pages: [source.page] });
          setNumPages(1);
          setImageUrl(objectUrl);
          setLoad({ phase: "ready" });
        }
      } catch {
        if (!cancelled) setLoad({ phase: "error", kind: "generic" });
      }
    })();

    return () => {
      cancelled = true;
      offCrash?.();
      created?.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, attempt, runDetection]);

  function retry() {
    if (onReloadSource) onReloadSource();
    else setAttempt((n) => n + 1);
  }

  function select(key: string | null) {
    setSelectedKey(key);
    setArmed(null);
    if (key === null) setDetailsKey(null);
  }

  function updateField(next: DraftField) {
    const page = pageByIndex.get(next.page);
    if (!page) return;
    const rect = clampField(next, page);
    const clamped: DraftField = {
      ...next,
      page: rect.page,
      x_ppm: rect.x_ppm,
      y_ppm: rect.y_ppm,
      w_ppm: rect.w_ppm,
      h_ppm: rect.h_ppm,
    };
    onFieldsChange(fields.map((f) => (f.key === next.key ? clamped : f)));
    const who = recipients.find((r) => r.key === clamped.recipientKey)?.name ?? "signer";
    setAnnounce(`${KIND_LABELS[clamped.kind]} for ${who} updated on page ${clamped.page + 1}.`);
  }

  function deleteField(key: string) {
    const f = fields.find((x) => x.key === key);
    onFieldsChange(fields.filter((x) => x.key !== key));
    if (selectedKey === key) setSelectedKey(null);
    if (detailsKey === key) setDetailsKey(null);
    if (f) setAnnounce(`${KIND_LABELS[f.kind]} box deleted from page ${f.page + 1}.`);
  }

  function handlePageClick(e: React.MouseEvent<HTMLDivElement>, pageIndex: number) {
    if (disabled) return;
    setDetailsKey(null);
    if (!armed || !active) {
      setSelectedKey(null);
      return;
    }
    const page = pageByIndex.get(pageIndex);
    const bounds = e.currentTarget.getBoundingClientRect();
    if (!page || bounds.width <= 0 || bounds.height <= 0) return;
    if (fields.length >= MAX_FIELDS) {
      setNotice(`An envelope can carry at most ${MAX_FIELDS} boxes.`);
      setArmed(null);
      return;
    }
    const size = pageSizeOf(page);
    const w = ptToPpm(DEFAULT_FIELD_PT[armed].w, size.vw);
    const h = ptToPpm(DEFAULT_FIELD_PT[armed].h, size.vh);
    const cx = ((e.clientX - bounds.left) / bounds.width) * PPM;
    const cy = ((e.clientY - bounds.top) / bounds.height) * PPM;
    const rect = clampField(
      { kind: armed, page: pageIndex, x_ppm: Math.round(cx - w / 2), y_ppm: Math.round(cy - h / 2), w_ppm: w, h_ppm: h },
      page
    );
    const key = nextStaffKey(fields);
    const field: DraftField = {
      key,
      recipientKey: active.key,
      kind: armed,
      page: rect.page,
      x_ppm: rect.x_ppm,
      y_ppm: rect.y_ppm,
      w_ppm: rect.w_ppm,
      h_ppm: rect.h_ppm,
      required: true,
      origin: "staff",
      detectedLabel: null,
      warn: null,
    };
    onFieldsChange([...fields, field]);
    setSelectedKey(key);
    setAnnounce(`${KIND_LABELS[armed]} box added for ${active.name} on page ${pageIndex + 1}.`);
    setArmed(null);
  }

  function scrollToPage(index: number) {
    document.getElementById(`${uid}-page-${index}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const gate = placementGate(fields, recipients, pages);
  const warnings = placementWarnings(fields, recipients);
  const ready = load.phase === "ready";

  const renderOverlay = (pageIndex: number, sizePx: { w: number; h: number }) => {
    const page = pageByIndex.get(pageIndex);
    const size = page ? pageSizeOf(page) : { index: pageIndex, vw: 612, vh: 792 };
    const onPage = fields.filter((f) => f.page === pageIndex);
    const details = onPage.find((f) => f.key === detailsKey) ?? null;
    return (
      <div
        id={`${uid}-page-${pageIndex}`}
        className={`absolute inset-0 ${disabled ? "pointer-events-none" : ""} ${armed ? "cursor-crosshair" : ""}`}
        onClick={(e) => handlePageClick(e, pageIndex)}
      >
        {onPage.map((f) => {
          const idx = recipientIndex(f.recipientKey);
          const who = idx >= 0 ? recipients[idx].name : "Removed signer";
          return (
            <FieldBox
              key={f.key}
              field={f}
              recipientIndex={idx + 1}
              recipientName={who}
              color={signerColor(idx)}
              pageSizePx={sizePx}
              pageSizePt={{ vw: size.vw, vh: size.vh }}
              selected={selectedKey === f.key}
              onSelect={() => select(f.key)}
              onChange={updateField}
              onDelete={() => deleteField(f.key)}
              pageCount={pageCount}
              onOpenDetails={() => setDetailsKey(f.key)}
            />
          );
        })}
        {details ? (
          <FieldDetails
            field={details}
            recipients={recipients}
            onChange={updateField}
            onDelete={() => deleteField(details.key)}
            onClose={() => setDetailsKey(null)}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div
      className="flex h-full min-h-0"
      onKeyDown={(e) => {
        // Escape peels back one layer at a time and never reaches the wizard.
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (detailsKey) setDetailsKey(null);
        else if (armed) setArmed(null);
        else if (selectedKey) setSelectedKey(null);
      }}
    >
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>

      {/* Page rail */}
      {ready ? (
        <nav aria-label="Pages" className="hidden w-28 shrink-0 overflow-y-auto border-r border-line bg-paper-soft p-2 lg:block">
          <ul className="space-y-2">
            {pageSizes.map((size) => {
              const onPage = fields.filter((f) => f.page === size.index);
              return (
                <li key={size.index}>
                  <button
                    type="button"
                    onClick={() => scrollToPage(size.index)}
                    aria-label={`Page ${size.index + 1}, ${onPage.length} box${onPage.length === 1 ? "" : "es"}`}
                    className="block w-full rounded p-0.5 hover:bg-white"
                  >
                    <span
                      className="relative block w-full overflow-hidden rounded-sm border border-line bg-white"
                      style={{ aspectRatio: `${size.vw} / ${size.vh}` }}
                    >
                      {onPage.map((f) => (
                        <span
                          key={f.key}
                          className="absolute rounded-[1px] opacity-80"
                          style={{ ...fieldPercentStyle(f), backgroundColor: signerColor(recipientIndex(f.recipientKey)) }}
                        />
                      ))}
                    </span>
                    <span className="mt-0.5 block text-center text-[10px] text-muted">{size.index + 1}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      <div className="min-w-0 flex-1 overflow-y-auto">
        {/* Toolbar */}
        <div className="sticky top-0 z-30 border-b border-line bg-white/95 px-3 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Signer for new boxes">
              {recipients.map((r, i) => {
                const color = signerColor(i);
                const count = fields.filter((f) => f.recipientKey === r.key).length;
                const isActive = active?.key === r.key;
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={isActive}
                    disabled={disabled}
                    onClick={() => setActiveKey(r.key)}
                    title={r.name}
                    className={`inline-flex max-w-[11rem] items-center gap-1.5 rounded-full border-2 py-0.5 pl-0.5 pr-2 text-xs font-semibold disabled:opacity-60 ${
                      isActive ? "bg-paper-soft text-ink" : "bg-white text-muted"
                    }`}
                    style={{ borderColor: isActive ? color : `${color}55` }}
                  >
                    <span
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] text-white"
                      style={{ backgroundColor: color }}
                    >
                      {i + 1}
                    </span>
                    <span className="shrink-0">{initials(r.name)}</span>
                    <span className="truncate font-normal">{r.name}</span>
                    <span className="shrink-0 font-normal text-muted-soft">({count})</span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Add a box">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={armed === k}
                  disabled={disabled || !ready || !active}
                  onClick={() => {
                    setArmed(armed === k ? null : k);
                    setSelectedKey(null);
                    setDetailsKey(null);
                  }}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-semibold disabled:opacity-50 ${
                    armed === k
                      ? "border-brand-400 bg-brand-50 text-brand-700"
                      : "border-line bg-white text-ink hover:bg-paper-soft"
                  }`}
                >
                  + {KIND_LABELS[k]}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-muted">
                <span>Zoom</span>
                <select
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink focus:border-brand-400 focus:outline-none"
                >
                  {ZOOMS.map((z) => (
                    <option key={z.label} value={z.value}>
                      {z.label}
                    </option>
                  ))}
                </select>
              </label>
              {source.mode === "pdf" ? (
                <button
                  type="button"
                  disabled={disabled || !ready || detecting || !sandbox}
                  onClick={() => {
                    if (!sandbox) return;
                    const hasDetected = fields.some((f) => f.origin === "detected");
                    if (hasDetected && !confirm("Replace the detected boxes? Boxes you added stay.")) return;
                    void runDetection(sandbox, numPages);
                  }}
                  className="rounded-lg border border-line bg-white px-2.5 py-1 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                >
                  {detecting ? "Detecting…" : "Re-run detection"}
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-1.5 space-y-0.5 text-xs">
            {armed && active ? (
              <p className="font-medium text-brand-700">
                Click the page to place a {KIND_LABELS[armed].toLowerCase()} box for {active.name}. Esc cancels.
              </p>
            ) : null}
            {ready ? (
              gate ? (
                <p className="font-medium text-red-700">{gate}</p>
              ) : (
                <p className="font-medium text-emerald-700">Every signer has a required signature box.</p>
              )
            ) : null}
            {warnings.map((w) => (
              <p key={w} className="text-amber-800">
                {w}
              </p>
            ))}
            {notice ? <p className="text-muted">{notice}</p> : null}
            {ready ? (
              <p className="text-muted-soft">
                Drag to move, drag a corner to resize. Arrow keys nudge (Shift for 10 pt), Alt+arrows resize, Enter
                edits, Delete removes.
              </p>
            ) : null}
          </div>
        </div>

        {/* Pages */}
        <div className="bg-paper-tint/60 p-3 sm:p-6">
          {load.phase === "loading" ? (
            <p className="py-16 text-center text-sm text-muted">Loading and verifying the document…</p>
          ) : load.phase === "error" ? (
            <div className="mx-auto max-w-lg rounded-xl border border-red-200 bg-white p-5 text-center">
              <p className="text-sm font-medium text-red-700">
                {load.kind === "pages"
                  ? "This PDF's page boxes are ambiguous. Print it to PDF and upload it again."
                  : load.kind === "assets"
                    ? "pdf.js assets are missing from this deploy (prebuild didn't run). Tell Tyler."
                    : "We couldn't load a preview. Try again."}
              </p>
              {load.kind !== "pages" ? (
                <button
                  type="button"
                  onClick={retry}
                  disabled={disabled}
                  className="mt-3 rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : source.mode === "pdf" ? (
            <PdfPages
              sandbox={sandbox}
              pages={pageSizes}
              maxLiveCanvases={6}
              zoom={zoom}
              renderOverlay={renderOverlay}
              onError={() => setLoad({ phase: "error", kind: "generic" })}
            />
          ) : imageUrl ? (
            <PdfPages
              sandbox={null}
              pages={pageSizes}
              image={{ url: imageUrl, rect: source.imageRect }}
              maxLiveCanvases={6}
              zoom={zoom}
              renderOverlay={renderOverlay}
              onError={() => setLoad({ phase: "error", kind: "generic" })}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The Enter / double-click popover: signer, kind and required for one box. */
function FieldDetails({
  field,
  recipients,
  onChange,
  onDelete,
  onClose,
}: {
  field: DraftField;
  recipients: DraftRecipient[];
  onChange: (f: DraftField) => void;
  onDelete: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const below = field.y_ppm + field.h_ppm < PPM * 0.7;
  const left = `${Math.min(field.x_ppm, PPM * 0.55) / 10_000}%`;
  const position: React.CSSProperties = below
    ? { left, top: `${(field.y_ppm + field.h_ppm) / 10_000}%`, marginTop: 6 }
    : { left, bottom: `${(PPM - field.y_ppm) / 10_000}%`, marginBottom: 6 };
  const selectClass =
    "mt-0.5 w-full rounded-md border border-line bg-white px-2 py-1 text-xs text-ink focus:border-brand-400 focus:outline-none";

  return (
    <div
      role="dialog"
      aria-label={`${KIND_LABELS[field.kind]} box details`}
      className="absolute z-40 w-60 rounded-lg border border-line bg-white p-3 text-xs shadow-xl"
      style={position}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="block font-medium text-muted">
        Signer
        <select
          autoFocus
          value={field.recipientKey}
          onChange={(e) => onChange({ ...field, recipientKey: e.target.value, warn: null })}
          className={selectClass}
        >
          {recipients.map((r, i) => (
            <option key={r.key} value={r.key}>
              {i + 1}. {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block font-medium text-muted">
        Kind
        <select
          value={field.kind}
          onChange={(e) => onChange({ ...field, kind: e.target.value as FieldKind, warn: null })}
          className={selectClass}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 flex items-center gap-2 text-ink">
        <input
          type="checkbox"
          checked={field.required}
          onChange={(e) => onChange({ ...field, required: e.target.checked })}
        />
        Required
      </label>
      {field.detectedLabel ? (
        <p className="mt-2 break-words text-muted-soft">Found near: {field.detectedLabel}</p>
      ) : null}
      <div className="mt-3 flex items-center justify-between">
        <button type="button" onClick={onDelete} className="rounded-md px-2 py-1 font-semibold text-red-600 hover:bg-red-50">
          Delete
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line px-2.5 py-1 font-semibold text-ink hover:bg-paper-soft"
        >
          Done
        </button>
      </div>
    </div>
  );
}
