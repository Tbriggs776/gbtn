"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

// Drawn-signature capture for the public signing page. Pointer events cover
// mouse, pen and touch; `touch-none` stops the page scrolling under a finger.
// The backing store is scaled by devicePixelRatio so strokes stay crisp, and the
// PNG is exported once per stroke (not on every move) onto a transparent canvas
// sized inside the server's checks in lib/esign/signature-image.ts (B.7).

const INK = "#11294a"; // --color-ink
const LINE_WIDTH = 2.25;

// B.7 accepts 100–2400 px wide, 40–1200 px tall, and at most 350 KB decoded.
// Export is capped at 1200 px wide so a normal signature lands far below the
// byte cap; a pathological one is stepped down until it fits.
const EXPORT_MAX_WIDTH = 1200;
const EXPORT_MAX_HEIGHT = 1200;
const SIGNATURE_MAX_BYTES = 350_000;
const DATA_URL_PREFIX = "data:image/png;base64,";

function decodedBytes(dataUrl: string): number {
  return Math.floor(((dataUrl.length - DATA_URL_PREFIX.length) * 3) / 4);
}

function exportPng(source: HTMLCanvasElement): string | null {
  const out = document.createElement("canvas");
  let scale = Math.min(
    1,
    EXPORT_MAX_WIDTH / source.width,
    EXPORT_MAX_HEIGHT / source.height
  );
  for (let i = 0; i < 6; i++) {
    out.width = Math.max(1, Math.round(source.width * scale));
    out.height = Math.max(1, Math.round(source.height * scale));
    // Resizing resets context state, so configure after sizing.
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, out.width, out.height);
    const png = out.toDataURL("image/png");
    if (!png.startsWith(DATA_URL_PREFIX)) return null;
    if (decodedBytes(png) <= SIGNATURE_MAX_BYTES) return png;
    scale *= 0.75;
  }
  return null;
}

function applyPen(ctx: CanvasRenderingContext2D, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = INK;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

export function SignaturePad({
  onChange,
  disabled = false,
  label = "Signature drawing area",
}: {
  /** Called with the exported PNG data URL (or null when cleared) and the
      total stroke length in CSS pixels. */
  onChange: (png: string | null, inkLength: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const ink = useRef(0);
  const size = useRef({ w: 0, h: 0, dpr: 0 });
  const onChangeRef = useRef(onChange);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Size the backing store to the rendered box × DPR. A real resize (rotation,
  // zoom, moving monitors) clears the pad, since the old strokes no longer map.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      const dpr = window.devicePixelRatio || 1;
      if (w === 0 || h === 0) return;
      const prev = size.current;
      if (prev.w === w && prev.h === h && prev.dpr === dpr) return;

      const first = prev.w === 0;
      size.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx) applyPen(ctx, dpr);

      drawing.current = false;
      last.current = null;
      ink.current = 0;
      if (!first) {
        setHasInk(false);
        onChangeRef.current(null, 0);
      }
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  function point(e: PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handleDown(e: PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety; drawing still works without it.
    }
    drawing.current = true;
    last.current = point(e);
  }

  function handleMove(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    const from = last.current;
    // One segment per move: re-stroking a growing path darkens the overlaps.
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ink.current += Math.hypot(p.x - from.x, p.y - from.y);
    last.current = p;
    if (!hasInk) setHasInk(true);
  }

  function handleUp(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Already released.
    }
    // A tap with no movement leaves no ink, so there is nothing new to export.
    if (ink.current <= 0) return;
    onChangeRef.current(exportPng(e.currentTarget), ink.current);
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    drawing.current = false;
    last.current = null;
    ink.current = 0;
    setHasInk(false);
    onChangeRef.current(null, 0);
  }

  return (
    <div>
      <div
        className={`relative overflow-hidden rounded-xl border-2 border-dashed ${
          disabled ? "border-line bg-paper-soft" : "border-brand-200 bg-white"
        }`}
      >
        {/* Signature baseline, under the canvas. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-6 bottom-11 border-b border-line"
        />
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={label}
          aria-disabled={disabled || undefined}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
          className={`relative block h-44 w-full touch-none select-none ${
            disabled ? "cursor-not-allowed" : "cursor-crosshair"
          }`}
        />
        {!hasInk ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center"
          >
            <span className="font-label text-[11px] uppercase tracking-[0.2em] text-muted-soft">
              Sign here
            </span>
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="sr-only" aria-live="polite">
          {hasInk ? "Signature drawn." : "No signature drawn yet."}
        </p>
        <button
          type="button"
          onClick={clear}
          disabled={disabled || !hasInk}
          className="ml-auto text-sm font-medium text-muted underline-offset-4 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          Clear signature
        </button>
      </div>
    </div>
  );
}
