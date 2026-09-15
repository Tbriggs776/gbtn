"use client";

import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { PdfSandbox } from "@/components/esign/pdf-sandbox";
import { fieldPercentStyle } from "@/lib/esign/geometry";
import type { FieldRect } from "@/lib/esign/types";

// Shared page renderer for the signing page and the staff placement step.
// Every page box is sized from its displayed points up front, so nothing jumps
// as pages render. Canvases exist only for pages near the viewport (nearest
// maxLiveCanvases win); evicted pages cancel their render in the sandbox and
// drop their backing store. Pixels come from the pdf.js sandbox as
// ImageBitmaps — this component never sees a PDF. Overlays are positioned in
// percent, so zoom changes no field state.

export type PageSize = { index: number; vw: number; vh: number }; // displayed points (displayDims)

const RENDER_CONCURRENCY = 2;
const RESCALE_TOLERANCE = 0.15;
const RESIZE_DEBOUNCE_MS = 150;

type LivePage = { gen: number; scale: number; rendering: boolean; drawn: boolean };

function isCancel(e: unknown): boolean {
  return e instanceof Error && e.name === "RenderingCancelledException";
}

function drawBitmap(canvas: HTMLCanvasElement, bitmap: ImageBitmap) {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const renderer = canvas.getContext("bitmaprenderer");
  if (renderer) {
    renderer.transferFromImageBitmap(bitmap);
    return;
  }
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
}

function clearCanvas(canvas: HTMLCanvasElement | undefined) {
  if (!canvas) return;
  try {
    canvas.getContext("bitmaprenderer")?.transferFromImageBitmap(null);
  } catch {
    // a 2d canvas: resizing below clears it
  }
  canvas.width = 0;
  canvas.height = 0;
}

export function PdfPages({
  sandbox,
  pages,
  image = null,
  maxLiveCanvases,
  maxCanvasPixels = 5_000_000,
  zoom,
  renderOverlay,
  onError,
}: {
  sandbox: PdfSandbox | null; // null in image mode
  pages: PageSize[];
  image?: { url: string; rect: FieldRect } | null; // blob: URL of hashed bytes on a white Letter page
  maxLiveCanvases: number; // wizard 6, signer 5
  maxCanvasPixels?: number;
  zoom: number; // 1 = fit width
  renderOverlay: (pageIndex: number, sizePx: { w: number; h: number }) => React.ReactNode;
  onError?: (e: unknown) => void; // any render rejection (an undecodable image included) or sandbox crash; once per sandbox, after which rendering stops
}): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [drawn, setDrawn] = useState<ReadonlySet<number>>(() => new Set());

  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const pageRefFns = useRef(new Map<number, (el: HTMLDivElement | null) => void>());
  const canvasRefFns = useRef(new Map<number, (el: HTMLCanvasElement | null) => void>());
  const visible = useRef(new Set<number>());
  const live = useRef(new Map<number, LivePage>());
  const inflight = useRef(0);
  const alive = useRef(true);
  const observer = useRef<IntersectionObserver | null>(null);
  const errored = useRef(false);
  const onErrorRef = useRef(onError);
  const cfg = useRef({ sandbox, maxLiveCanvases, maxCanvasPixels });
  const sizes = useRef(new Map<number, PageSize>());

  function reportError(e: unknown) {
    if (!alive.current || errored.current) return;
    errored.current = true;
    onErrorRef.current?.(e);
  }

  function markDrawn(index: number, on: boolean) {
    setDrawn((prev) => {
      if (prev.has(index) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function evict(index: number) {
    const st = live.current.get(index);
    if (!st) return;
    live.current.delete(index);
    if (st.rendering) cfg.current.sandbox?.cancel(index);
    clearCanvas(canvases.current.get(index));
    if (st.drawn) markDrawn(index, false);
  }

  function evictAll() {
    for (const index of Array.from(live.current.keys())) evict(index);
  }

  function targetScale(index: number): number | null {
    const size = sizes.current.get(index);
    const el = pageEls.current.get(index);
    if (!size || !el || size.vw <= 0 || size.vh <= 0) return null;
    const cssW = el.clientWidth;
    if (!cssW) return null;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(
      (cssW * dpr) / size.vw,
      Math.sqrt(cfg.current.maxCanvasPixels / (size.vw * size.vh))
    );
    return Number.isFinite(scale) && scale > 0 ? scale : null;
  }

  function start(sb: PdfSandbox, index: number, st: LivePage, scale: number) {
    const gen = ++st.gen;
    st.rendering = true;
    inflight.current += 1;
    let task: Promise<ImageBitmap>;
    try {
      task = sb.renderPage(index, scale);
    } catch (e) {
      task = Promise.reject(e);
    }
    task
      .then(
        (bitmap) => {
          const canvas = canvases.current.get(index);
          const current = live.current.get(index) === st && st.gen === gen;
          if (!alive.current || !current || !canvas || cfg.current.sandbox !== sb) {
            bitmap.close();
            return;
          }
          drawBitmap(canvas, bitmap);
          st.scale = scale;
          if (!st.drawn) {
            st.drawn = true;
            markDrawn(index, true);
          }
        },
        (e: unknown) => {
          const current = live.current.get(index) === st && st.gen === gen;
          if (!alive.current || !current || cfg.current.sandbox !== sb || isCancel(e)) return;
          reportError(e);
        }
      )
      .finally(() => {
        inflight.current = Math.max(0, inflight.current - 1);
        if (live.current.get(index) === st && st.gen === gen) st.rendering = false;
        schedule();
      });
  }

  function schedule() {
    if (!alive.current) return;
    const sb = cfg.current.sandbox;
    if (!sb) {
      evictAll();
      return;
    }
    // The visible pages nearest the viewport centre get the live canvases.
    const middle = window.innerHeight / 2;
    const wanted = Array.from(visible.current)
      .filter((index) => sizes.current.has(index))
      .map((index) => {
        const r = pageEls.current.get(index)?.getBoundingClientRect();
        return { index, d: r ? Math.abs((r.top + r.bottom) / 2 - middle) : Number.POSITIVE_INFINITY };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, Math.max(1, cfg.current.maxLiveCanvases))
      .map((x) => x.index);
    const keep = new Set(wanted);
    for (const index of Array.from(live.current.keys())) {
      if (!keep.has(index)) evict(index);
    }
    // A reported failure is final for this sandbox. The sandbox fails a page
    // whose image it could not decode rather than hand back a blank bitmap, and
    // that failure is deterministic, so re-rendering would only loop. The
    // consumer swaps to its fallback (signer) or error state (wizard).
    if (errored.current) return;
    for (const index of wanted) {
      if (inflight.current >= RENDER_CONCURRENCY) break;
      const existing = live.current.get(index);
      if (existing?.rendering) continue;
      const scale = targetScale(index);
      if (scale === null) continue;
      if (existing?.drawn && Math.abs(existing.scale / scale - 1) <= RESCALE_TOLERANCE) continue;
      const st = existing ?? { gen: 0, scale: 0, rendering: false, drawn: false };
      live.current.set(index, st);
      start(sb, index, st, scale);
    }
  }

  // Keep the latest props visible to the imperative scheduler. Declared first
  // so it runs before the effects below in every commit.
  useEffect(() => {
    onErrorRef.current = onError;
    cfg.current = { sandbox, maxLiveCanvases, maxCanvasPixels };
    sizes.current = new Map(pages.map((p) => [p.index, p]));
    schedule();
  });

  useEffect(() => {
    alive.current = true;
    if (typeof IntersectionObserver === "undefined") {
      for (const index of pageEls.current.keys()) visible.current.add(index);
      schedule();
      return () => {
        alive.current = false;
        evictAll();
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (!Number.isInteger(index)) continue;
          if (entry.isIntersecting) visible.current.add(index);
          else visible.current.delete(index);
        }
        schedule();
      },
      { rootMargin: "100% 0px" }
    );
    observer.current = io;
    for (const el of pageEls.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observer.current = null;
      visible.current.clear();
      evictAll();
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new sandbox (or none) starts from scratch.
  useEffect(() => {
    if (!sandbox) return;
    errored.current = false;
    schedule(); // the every-commit effect above ran while the old sandbox's error still stood
    const off = sandbox.onCrash(() => reportError(new Error("PdfSandboxCrash")));
    return () => {
      off();
      evictAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandbox]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => setContainerW(Math.floor(el.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      measure();
      if (timer) clearTimeout(timer);
      timer = setTimeout(schedule, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pageRef(index: number) {
    let fn = pageRefFns.current.get(index);
    if (!fn) {
      fn = (el: HTMLDivElement | null) => {
        const prev = pageEls.current.get(index);
        if (prev && prev !== el) {
          observer.current?.unobserve(prev);
          pageEls.current.delete(index);
          visible.current.delete(index);
        }
        if (el) {
          pageEls.current.set(index, el);
          observer.current?.observe(el);
        }
      };
      pageRefFns.current.set(index, fn);
    }
    return fn;
  }

  function canvasRef(index: number) {
    let fn = canvasRefFns.current.get(index);
    if (!fn) {
      fn = (el: HTMLCanvasElement | null) => {
        if (el) canvases.current.set(index, el);
        else canvases.current.delete(index);
      };
      canvasRefFns.current.set(index, fn);
    }
    return fn;
  }

  const pageW = containerW > 0 ? containerW * zoom : 0;
  const total = pages.length;

  return (
    <div ref={scrollerRef} className="w-full overflow-x-auto">
      <div className="space-y-4 py-1" style={pageW > containerW ? { width: pageW } : undefined}>
        {pages.map((p, n) => {
          const pageH = pageW > 0 ? (pageW * p.vh) / p.vw : 0;
          const showImage = image !== null && n === 0;
          return (
            <div
              key={p.index}
              ref={pageRef(p.index)}
              data-page-index={p.index}
              role="group"
              aria-label={`Page ${n + 1} of ${total}`}
              className="relative mx-auto bg-white shadow-sm ring-1 ring-line"
              style={
                pageW > 0
                  ? { width: pageW, height: pageH }
                  : { width: "100%", aspectRatio: `${p.vw} / ${p.vh}` }
              }
            >
              {showImage && image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image.url}
                  alt=""
                  draggable={false}
                  referrerPolicy="no-referrer"
                  className="pointer-events-none absolute select-none"
                  style={fieldPercentStyle(image.rect)}
                />
              ) : (
                <canvas
                  ref={canvasRef(p.index)}
                  aria-hidden="true"
                  width={0}
                  height={0}
                  className="pointer-events-none absolute inset-0 h-full w-full select-none"
                />
              )}
              {!image && !drawn.has(p.index) ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted-soft"
                >
                  Loading page {n + 1}…
                </div>
              ) : null}
              {pageW > 0 ? (
                <div className="absolute inset-0">{renderOverlay(p.index, { w: pageW, h: pageH })}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
