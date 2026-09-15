"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { PPM, type FieldKind, type FieldRect } from "@/lib/esign/types";
import { MIN_SIGNATURE_PT, MIN_TEXT_PT, fieldPercentStyle, ptToPpm } from "@/lib/esign/geometry";
import type { DraftField } from "@/lib/esign/detect-fields";

// One editable signature/date/name box in the placement step. Geometry lives in
// integer ppm of the displayed page (top-left origin), so the box is positioned
// with percentages and zoom never changes field state. While dragging, the box
// keeps a local draft (rAF-batched); the parent only hears about the committed
// rectangle on pointerup, and re-clamps it against the real page with
// geometry.clampField.

export const KIND_LABELS: Record<FieldKind, string> = {
  signature: "Signature",
  date_signed: "Date signed",
  printed_name: "Printed name",
};

type Mode = "move" | "nw" | "ne" | "sw" | "se";
type Rect = { x: number; y: number; w: number; h: number };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

function minPpm(kind: FieldKind, pt: { vw: number; vh: number }): { w: number; h: number } {
  const min = kind === "signature" ? MIN_SIGNATURE_PT : MIN_TEXT_PT;
  return { w: Math.min(PPM, ptToPpm(min.w, pt.vw)), h: Math.min(PPM, ptToPpm(min.h, pt.vh)) };
}

function toRect(f: FieldRect): Rect {
  return { x: f.x_ppm, y: f.y_ppm, w: f.w_ppm, h: f.h_ppm };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Apply a ppm delta for a drag mode, keeping the minimum size and the page bounds. */
function applyDelta(r0: Rect, mode: Mode, dx: number, dy: number, min: { w: number; h: number }): Rect {
  if (mode === "move") {
    return {
      x: Math.round(clamp(r0.x + dx, 0, PPM - r0.w)),
      y: Math.round(clamp(r0.y + dy, 0, PPM - r0.h)),
      w: r0.w,
      h: r0.h,
    };
  }
  const right0 = r0.x + r0.w;
  const bottom0 = r0.y + r0.h;
  let left = r0.x;
  let top = r0.y;
  let right = right0;
  let bottom = bottom0;
  if (mode === "nw" || mode === "sw") left = clamp(r0.x + dx, 0, right0 - min.w);
  if (mode === "ne" || mode === "se") right = clamp(right0 + dx, r0.x + min.w, PPM);
  if (mode === "nw" || mode === "ne") top = clamp(r0.y + dy, 0, bottom0 - min.h);
  if (mode === "sw" || mode === "se") bottom = clamp(bottom0 + dy, r0.y + min.h, PPM);
  return {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(right - left),
    h: Math.round(bottom - top),
  };
}

function KindIcon({ kind }: { kind: FieldKind }): React.JSX.Element {
  if (kind === "signature") {
    return (
      <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" aria-hidden="true">
        <path d="M2 13c2-1 3-5 5-5s0 4 2 4 2-3 5-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "date_signed") {
    return (
      <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" aria-hidden="true">
        <rect x="2" y="3.5" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M2 7h12M5.5 2v3M10.5 2v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" aria-hidden="true">
      <path d="M3 13l3-10 3 10M4.2 9.5h3.6M11 13V7m0 0c0-1 .8-1.5 2-1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

const HANDLES: { mode: Exclude<Mode, "move">; className: string; cursor: string }[] = [
  { mode: "nw", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { mode: "ne", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { mode: "sw", className: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2", cursor: "nesw-resize" },
  { mode: "se", className: "bottom-0 right-0 translate-x-1/2 translate-y-1/2", cursor: "nwse-resize" },
];

export function FieldBox({
  field,
  recipientIndex,
  recipientName,
  color,
  pageSizePx,
  pageSizePt,
  selected,
  onSelect,
  onChange,
  onDelete,
  pageCount,
  onOpenDetails,
}: {
  field: DraftField;
  recipientIndex: number;
  recipientName: string;
  color: string;
  pageSizePx: { w: number; h: number };
  pageSizePt: { vw: number; vh: number };
  selected: boolean;
  onSelect: () => void;
  onChange: (f: DraftField) => void;
  onDelete: () => void;
  /** For the accessible name ("page 3 of 9"). */
  pageCount?: number;
  /** Enter on a focused box opens the parent's details popover. */
  onOpenDetails?: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Rect | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    mode: Mode;
    sx: number;
    sy: number;
    r0: Rect;
    latest: Rect;
    moved: boolean;
  } | null>(null);
  const frame = useRef<number | null>(null);

  // A selected box takes focus so the keyboard shortcuts apply to it.
  useEffect(() => {
    if (selected && boxRef.current && document.activeElement !== boxRef.current) {
      boxRef.current.focus({ preventScroll: true });
    }
  }, [selected]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    []
  );

  const rect = draft ?? toRect(field);
  const min = minPpm(field.kind, pageSizePt);

  function commit(r: Rect) {
    if (r.x === field.x_ppm && r.y === field.y_ppm && r.w === field.w_ppm && r.h === field.h_ppm) return;
    // Staff touched it, so the "check this box" nudge has been answered.
    onChange({ ...field, x_ppm: r.x, y_ppm: r.y, w_ppm: r.w, h_ppm: r.h, warn: null });
  }

  function startDrag(e: React.PointerEvent<HTMLElement>, mode: Mode) {
    if (e.button !== 0) return;
    // Never let the page's click-to-create layer see this pointer.
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort (e.g. a synthetic pointer).
    }
    const r0 = toRect(field);
    drag.current = { pointerId: e.pointerId, mode, sx: e.clientX, sy: e.clientY, r0, latest: r0, moved: false };
  }

  function moveDrag(e: React.PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    if (pageSizePx.w <= 0 || pageSizePx.h <= 0) return;
    const dx = ((e.clientX - d.sx) / pageSizePx.w) * PPM;
    const dy = ((e.clientY - d.sy) / pageSizePx.h) * PPM;
    d.latest = applyDelta(d.r0, d.mode, dx, dy, min);
    d.moved = true;
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (drag.current) setDraft(drag.current.latest);
      });
    }
  }

  function endDrag(e: React.PointerEvent<HTMLElement>, cancel: boolean) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    drag.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    setDraft(null);
    if (!cancel && d.moved) commit(d.latest);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      onDelete();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onSelect();
      onOpenDetails?.();
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const dir = arrows[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const stepPt = e.shiftKey ? 10 : 1;
    const dx = dir[0] * ptToPpm(stepPt, pageSizePt.vw);
    const dy = dir[1] * ptToPpm(stepPt, pageSizePt.vh);
    const r0 = toRect(field);
    // Alt+arrows resize from the bottom-right corner; plain arrows move.
    commit(applyDelta(r0, e.altKey ? "se" : "move", dx, dy, min));
  }

  const kindLabel = KIND_LABELS[field.kind];
  const pageText = pageCount ? `page ${field.page + 1} of ${pageCount}` : `page ${field.page + 1}`;
  const badge =
    field.warn === "check_detected"
      ? "Check this box"
      : field.warn === "fallback"
        ? "No signature line found — check"
        : null;

  return (
    <div
      ref={boxRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${kindLabel} for ${recipientName} — ${pageText}${field.required ? "" : " (optional)"}`}
      onPointerDown={(e) => startDrag(e, "move")}
      onPointerMove={moveDrag}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpenDetails?.();
      }}
      onKeyDown={onKeyDown}
      className={`absolute touch-none select-none rounded-[3px] border-2 outline-none ${
        selected ? "z-20 shadow-lg" : "z-10"
      } ${field.required ? "border-solid" : "border-dashed"} cursor-move focus-visible:ring-2 focus-visible:ring-brand-400`}
      style={{
        ...fieldPercentStyle({ page: field.page, x_ppm: rect.x, y_ppm: rect.y, w_ppm: rect.w, h_ppm: rect.h }),
        borderColor: color,
        backgroundColor: `${color}1f`,
      }}
    >
      <div
        className="pointer-events-none absolute left-0 top-0 flex max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-br px-1 py-px text-[10px] font-semibold leading-tight text-white"
        style={{ backgroundColor: color }}
      >
        <span>{recipientIndex}</span>
        <span>{initials(recipientName)}</span>
        <KindIcon kind={field.kind} />
        <span className="hidden sm:inline">{kindLabel}</span>
        {field.required ? null : <span className="font-normal opacity-80">optional</span>}
      </div>
      {badge ? (
        <div className="pointer-events-none absolute left-0 top-full mt-0.5 whitespace-nowrap rounded bg-amber-100 px-1 py-px text-[10px] font-semibold text-amber-900 ring-1 ring-amber-300">
          {badge}
        </div>
      ) : null}
      {selected ? (
        <>
          {HANDLES.map((h) => (
            <span
              key={h.mode}
              aria-hidden="true"
              onPointerDown={(e) => startDrag(e, h.mode)}
              onPointerMove={moveDrag}
              onPointerUp={(e) => endDrag(e, false)}
              onPointerCancel={(e) => endDrag(e, true)}
              className={`absolute grid h-4 w-4 touch-none place-items-center pointer-coarse:h-11 pointer-coarse:w-11 ${h.className}`}
              style={{ cursor: h.cursor }}
            >
              <span className="block h-2.5 w-2.5 rounded-sm border border-white" style={{ backgroundColor: color }} />
            </span>
          ))}
          <button
            type="button"
            aria-label={`Delete ${kindLabel.toLowerCase()} box for ${recipientName}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="absolute -right-3 -top-3 grid h-6 w-6 place-items-center rounded-full border border-line bg-white text-muted shadow hover:text-red-600 pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </>
      ) : null}
    </div>
  );
}
