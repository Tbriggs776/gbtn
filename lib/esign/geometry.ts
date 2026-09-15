import { PPM, type FieldKind, type FieldRect, type Rotation, type SnapshotPage } from "./types";

// The one implementation of e-sign field geometry (spec §A.1). Shared: the
// placement wizard and field detection run it in the browser; seal.ts,
// conversion.ts, signature-page.ts and engine.ts run it on the server, so both
// sides produce identical integers. Pure math: no DOM, no pdf.js, no pdf-lib.
//
// Stored field units are integer parts-per-million of the DISPLAYED page
// (rotated, cropped), origin top-left, y down. Page geometry is the effective
// view box in integer millipoints plus a rotation in {0, 90, 180, 270}.

export type Box = { x: number; y: number; w: number; h: number };             // points
export type UserRect = { ux: number; uy: number; uw: number; uh: number };    // points
export type Rect4 = [number, number, number, number];                          // [x0, y0, x1, y1]

export const MIN_SIGNATURE_PT = { w: 90, h: 22 } as const;
export const MIN_TEXT_PT = { w: 50, h: 10 } as const;
export const MIN_PAGE_SIDE_PT = 72;
export const DEFAULT_FIELD_PT: Record<FieldKind, { w: number; h: number }> = {
  signature: { w: 180, h: 44 },
  date_signed: { w: 120, h: 16 },
  printed_name: { w: 170, h: 16 },
};

const FIELD_KINDS: readonly string[] = ["signature", "date_signed", "printed_name"];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampPpm(v: number): number {
  return Math.min(PPM, Math.max(0, v));
}

/** null when angle % 90 !== 0 (refuse the page). Negative and >360 values fold. */
export function normalizeRotation(angle: number): Rotation | null {
  if (!isFiniteNumber(angle) || angle % 90 !== 0) return null;
  const r = (((angle % 360) + 360) % 360) || 0;
  return r === 0 || r === 90 || r === 180 || r === 270 ? r : null;
}

/** Ordered corners [x0, y0, x1, y1] with positive area, or null. Kept as corners so intersections match pdf.js exactly. */
function orderedCorners(r: readonly number[]): Rect4 | null {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(isFiniteNumber)) return null;
  const x0 = Math.min(r[0], r[2]), x1 = Math.max(r[0], r[2]);
  const y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
  return x1 - x0 > 0 && y1 - y0 > 0 ? [x0, y0, x1, y1] : null;
}

function cornersToBox(c: Rect4): Box {
  return { x: c[0], y: c[1], w: c[2] - c[0], h: c[3] - c[1] };
}

/** Swap reversed corners; null on zero/negative area or non-finite values. */
export function normalizeRect(r: Rect4): Box | null {
  const c = orderedCorners(r);
  return c ? cornersToBox(c) : null;
}

/** intersect(crop, media); media when crop is null/empty/invalid. Throws only if media is invalid. Mirrors pdf.js page.view. */
export function effectiveViewBox(media: Rect4, crop: Rect4 | null): Box {
  const m = orderedCorners(media);
  if (!m) throw new RangeError("effectiveViewBox: invalid MediaBox.");
  const c = crop ? orderedCorners(crop) : null;
  if (!c) return cornersToBox(m);
  const x0 = Math.max(m[0], c[0]), y0 = Math.max(m[1], c[1]);
  const x1 = Math.min(m[2], c[2]), y1 = Math.min(m[3], c[3]);
  return x1 - x0 > 0 && y1 - y0 > 0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : cornersToBox(m);
}

export function displayDims(box: Box, r: Rotation): { vw: number; vh: number } {
  return r === 90 || r === 270 ? { vw: box.h, vh: box.w } : { vw: box.w, vh: box.h };
}

/** Math.round(v * 1000), with -0 folded to 0 (canonicalJson and jsonb must agree). */
export function boxToMpt(box: Box): [number, number, number, number] {
  const m = (v: number) => Math.round(v * 1000) || 0;
  return [m(box.x), m(box.y), m(box.w), m(box.h)];
}

export function mptToBox(mpt: [number, number, number, number]): Box {
  return { x: mpt[0] / 1000, y: mpt[1] / 1000, w: mpt[2] / 1000, h: mpt[3] / 1000 };
}

export function pageBox(p: SnapshotPage): { box: Box; r: Rotation } {
  return { box: mptToBox(p.box_mpt), r: p.rotate };
}

/** §A.1 table: view-space field (ppm, top-left origin) → PDF user-space rect. */
export function fieldToUserRect(f: FieldRect, box: Box, r: Rotation): UserRect {
  const { vw: VW, vh: VH } = displayDims(box, r);
  const vx = (f.x_ppm * VW) / PPM;
  const vw = (f.w_ppm * VW) / PPM;
  const vh = (f.h_ppm * VH) / PPM;
  const Y = VH - (f.y_ppm * VH) / PPM - vh;
  switch (r) {
    case 90:
      return { ux: box.x + box.w - Y - vh, uy: box.y + vx, uw: vh, uh: vw };
    case 180:
      return { ux: box.x + box.w - vx - vw, uy: box.y + box.h - Y - vh, uw: vw, uh: vh };
    case 270:
      return { ux: box.x + Y, uy: box.y + box.h - vx - vw, uw: vh, uh: vw };
    default:
      return { ux: box.x + vx, uy: box.y + Y, uw: vw, uh: vh };
  }
}

/** §A.1 O_r + R_r: a field-local point (origin bottom-left, y up, display orientation) → user space. */
export function fieldLocalToUser(lx: number, ly: number, rect: UserRect, r: Rotation): { x: number; y: number } {
  switch (r) {
    case 90:
      return { x: rect.ux + rect.uw - ly, y: rect.uy + lx };
    case 180:
      return { x: rect.ux + rect.uw - lx, y: rect.uy + rect.uh - ly };
    case 270:
      return { x: rect.ux + ly, y: rect.uy + rect.uh - lx };
    default:
      return { x: rect.ux + lx, y: rect.uy + ly };
  }
}

/** User-space point → displayed-page point in points (origin top-left, y down). Unclamped. */
function userPointToView(px: number, py: number, box: Box, r: Rotation): { u: number; v: number } {
  switch (r) {
    case 90:
      return { u: py - box.y, v: px - box.x };
    case 180:
      return { u: box.x + box.w - px, v: py - box.y };
    case 270:
      return { u: box.y + box.h - py, v: box.x + box.w - px };
    default:
      return { u: px - box.x, v: box.y + box.h - py };
  }
}

/** Inverse of the view→user mapping, for detection. Unrounded ppm, clamped to [0, PPM]. */
export function userPointToPpm(px: number, py: number, box: Box, r: Rotation): { u: number; v: number } {
  const { vw, vh } = displayDims(box, r);
  const p = userPointToView(px, py, box, r);
  return {
    u: vw > 0 ? clampPpm((p.u / vw) * PPM) : 0,
    v: vh > 0 ? clampPpm((p.v / vh) * PPM) : 0,
  };
}

/** Axis-aligned bounding field of arbitrary user-space corners. Integer ppm, clamped. */
export function userCornersToField(page: number, corners: { x: number; y: number }[], box: Box, r: Rotation): FieldRect {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const c of corners) {
    if (!isFiniteNumber(c.x) || !isFiniteNumber(c.y)) continue;
    const p = userPointToPpm(c.x, c.y, box, r);
    u0 = Math.min(u0, p.u);
    v0 = Math.min(v0, p.v);
    u1 = Math.max(u1, p.u);
    v1 = Math.max(v1, p.v);
  }
  if (!Number.isFinite(u0) || !Number.isFinite(v0)) return { page, x_ppm: 0, y_ppm: 0, w_ppm: 0, h_ppm: 0 };
  const x = Math.round(u0);
  const y = Math.round(v0);
  return { page, x_ppm: x, y_ppm: y, w_ppm: Math.max(0, Math.round(u1) - x), h_ppm: Math.max(0, Math.round(v1) - y) };
}

/** Points → ppm on a displayed axis, rounded, clamped to [0, PPM]. */
export function ptToPpm(pt: number, displayedSidePt: number): number {
  if (!isFiniteNumber(pt) || !isFiniteNumber(displayedSidePt) || displayedSidePt <= 0) return 0;
  return clampPpm(Math.round((pt / displayedSidePt) * PPM));
}

export function ppmToPt(ppm: number, displayedSidePt: number): number {
  return (ppm * displayedSidePt) / PPM;
}

/** null when valid; otherwise a short staff-facing reason. Enforces §A.1 validation. */
export function validateField(f: FieldRect & { kind: FieldKind }, page: SnapshotPage, pageCount: number): string | null {
  if (!FIELD_KINDS.includes(f.kind)) return "Unknown box type.";
  if (![f.page, f.x_ppm, f.y_ppm, f.w_ppm, f.h_ppm].every((v) => Number.isSafeInteger(v))) {
    return "Box positions must be whole numbers.";
  }
  if (!Number.isSafeInteger(pageCount) || f.page < 0 || f.page >= pageCount) return "This box is on a page that doesn't exist.";
  if (!page || page.index !== f.page) return "This box doesn't match its page.";
  const r = normalizeRotation(page.rotate);
  if (r === null) return "This page is rotated by an unsupported angle.";
  if (!Array.isArray(page.box_mpt) || page.box_mpt.length !== 4 || !page.box_mpt.every((v) => Number.isSafeInteger(v))) {
    return "This page's size couldn't be read.";
  }
  const box = mptToBox(page.box_mpt);
  if (!(box.w > 0 && box.h > 0)) return "This page's size couldn't be read.";
  const { vw, vh } = displayDims(box, r);
  if (vw < MIN_PAGE_SIDE_PT || vh < MIN_PAGE_SIDE_PT) return "This page is smaller than 1 inch on a side.";
  if (f.x_ppm < 0 || f.y_ppm < 0 || f.w_ppm <= 0 || f.h_ppm <= 0 || f.x_ppm + f.w_ppm > PPM || f.y_ppm + f.h_ppm > PPM) {
    return "This box is off the page.";
  }
  const min = f.kind === "signature" ? MIN_SIGNATURE_PT : MIN_TEXT_PT;
  const EPSILON = 1e-6;
  if (ppmToPt(f.w_ppm, vw) + EPSILON < min.w || ppmToPt(f.h_ppm, vh) + EPSILON < min.h) {
    return f.kind === "signature"
      ? `Signature boxes must be at least ${min.w} × ${min.h} pt.`
      : `Date and name boxes must be at least ${min.w} × ${min.h} pt.`;
  }
  return null;
}

/** Clamp inside the page and enforce the kind's minimum size without moving the centre where possible. */
export function clampField(f: FieldRect & { kind: FieldKind }, page: SnapshotPage): FieldRect {
  const { box, r } = pageBox(page);
  const { vw, vh } = displayDims(box, r);
  const min = f.kind === "signature" ? MIN_SIGNATURE_PT : MIN_TEXT_PT;
  const num = (v: number) => (isFiniteNumber(v) ? v : 0);
  const minW = vw > 0 ? Math.min(PPM, Math.ceil((min.w * PPM) / vw)) : PPM;
  const minH = vh > 0 ? Math.min(PPM, Math.ceil((min.h * PPM) / vh)) : PPM;
  const w = Math.min(PPM, Math.max(minW, Math.round(num(f.w_ppm))));
  const h = Math.min(PPM, Math.max(minH, Math.round(num(f.h_ppm))));
  const cx = num(f.x_ppm) + num(f.w_ppm) / 2;
  const cy = num(f.y_ppm) + num(f.h_ppm) / 2;
  const x = Math.min(PPM - w, Math.max(0, Math.round(cx - w / 2)));
  const y = Math.min(PPM - h, Math.max(0, Math.round(cy - h / 2)));
  return { page: f.page, x_ppm: x, y_ppm: y, w_ppm: w, h_ppm: h };
}

/**
 * Image-to-page layout shared by conversion.ts and the wizard. displayW/H are
 * the pixel dims AFTER EXIF orientation. Page = US Letter in the image's
 * orientation; margin 36 pt; upscale capped at 2 pt/px.
 */
export function imagePageLayout(displayW: number, displayH: number): {
  pageW: number; pageH: number; drawX: number; drawY: number; drawW: number; drawH: number;
  /** The image rect as a field-style rect on page 0 (for the wizard overlay). */
  imageRect: FieldRect;
} {
  const dW = isFiniteNumber(displayW) && displayW > 0 ? displayW : 1;
  const dH = isFiniteNumber(displayH) && displayH > 0 ? displayH : 1;
  const landscape = dW > dH;
  const pageW = landscape ? 792 : 612;
  const pageH = landscape ? 612 : 792;
  const margin = 36;
  const scale = Math.min((pageW - 2 * margin) / dW, (pageH - 2 * margin) / dH, 2);
  const drawW = dW * scale;
  const drawH = dH * scale;
  const drawX = (pageW - drawW) / 2;
  const drawY = (pageH - drawH) / 2;
  const imageRect: FieldRect = {
    page: 0,
    x_ppm: ptToPpm(drawX, pageW),
    y_ppm: ptToPpm(pageH - drawY - drawH, pageH),
    w_ppm: ptToPpm(drawW, pageW),
    h_ppm: ptToPpm(drawH, pageH),
  };
  return { pageW, pageH, drawX, drawY, drawW, drawH, imageRect };
}

/** pdf.js page.view is ALREADY the effective box ([x0,y0,x1,y1]); null on invalid box or non-90° rotate. */
export function pageFromPdfjs(index: number, view: readonly number[], rotate: number): SnapshotPage | null {
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const r = normalizeRotation(rotate);
  if (r === null) return null;
  const c = orderedCorners(view);
  if (!c) return null;
  return { index, rotate: r, box_mpt: boxToMpt(cornersToBox(c)) };
}

/** Same length, same index order, equal rotate, every box_mpt component within tolMpt (default 1). */
export function pagesAgree(a: readonly SnapshotPage[], b: readonly SnapshotPage[], tolMpt = 1): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    if (!p || !q || p.index !== q.index || p.rotate !== q.rotate) return false;
    if (!Array.isArray(p.box_mpt) || !Array.isArray(q.box_mpt) || p.box_mpt.length !== 4 || q.box_mpt.length !== 4) return false;
    for (let k = 0; k < 4; k++) {
      if (!(Math.abs(p.box_mpt[k] - q.box_mpt[k]) <= tolMpt)) return false;
    }
  }
  return true;
}

/** Percent CSS for an overlay: { left, top, width, height } as "12.3456%" strings. */
export function fieldPercentStyle(f: FieldRect): { left: string; top: string; width: string; height: string } {
  const pct = (v: number) => `${((isFiniteNumber(v) ? v : 0) / 10_000).toFixed(4)}%`;
  return { left: pct(f.x_ppm), top: pct(f.y_ppm), width: pct(f.w_ppm), height: pct(f.h_ppm) };
}

/**
 * Dev-time property check (there are no tests in this repo): failures of
 * fieldToUserRect ∘ userCornersToField ≈ identity within 0.01 pt for all four
 * rotations on three boxes, plus a few invariants of the other helpers.
 */
export function geometrySelfCheck(): string[] {
  const failures: string[] = [];
  const boxes: { name: string; box: Box }[] = [
    { name: "Letter", box: { x: 0, y: 0, w: 612, h: 792 } },
    { name: "A4 landscape", box: { x: 0, y: 0, w: 841.89, h: 595.28 } },
    { name: "offset crop", box: { x: 18.5, y: 36.25, w: 500, h: 700 } },
  ];
  const samples: FieldRect[] = [
    { page: 0, x_ppm: 0, y_ppm: 0, w_ppm: 250_000, h_ppm: 60_000 },
    { page: 0, x_ppm: 123_457, y_ppm: 654_321, w_ppm: 300_001, h_ppm: 55_555 },
    { page: 0, x_ppm: 700_000, y_ppm: 940_000, w_ppm: 300_000, h_ppm: 60_000 },
  ];
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  const rotations: Rotation[] = [0, 90, 180, 270];
  for (const { name, box } of boxes) {
    for (const r of rotations) {
      const { vw, vh } = displayDims(box, r);
      for (const f of samples) {
        const u = fieldToUserRect(f, box, r);
        const back = userCornersToField(f.page, [{ x: u.ux, y: u.uy }, { x: u.ux + u.uw, y: u.uy + u.uh }], box, r);
        const u2 = fieldToUserRect(back, box, r);
        if (!close(u.ux, u2.ux) || !close(u.uy, u2.uy) || !close(u.uw, u2.uw) || !close(u.uh, u2.uh)) {
          failures.push(`${name} r=${r}: field round trip moved the box`);
        }
        if (u.ux < box.x - 0.01 || u.uy < box.y - 0.01 || u.ux + u.uw > box.x + box.w + 0.01 || u.uy + u.uh > box.y + box.h + 0.01) {
          failures.push(`${name} r=${r}: field left the page box`);
        }
        const fw = (f.w_ppm * vw) / PPM;
        const fh = (f.h_ppm * vh) / PPM;
        for (const [lx, ly] of [[0, 0], [fw, fh], [fw, 0], [0, fh]]) {
          const p = fieldLocalToUser(lx, ly, u, r);
          if (p.x < u.ux - 0.01 || p.x > u.ux + u.uw + 0.01 || p.y < u.uy - 0.01 || p.y > u.uy + u.uh + 0.01) {
            failures.push(`${name} r=${r}: local point (${lx.toFixed(1)}, ${ly.toFixed(1)}) fell outside the field`);
          }
        }
      }
    }
  }
  const pj = pageFromPdfjs(0, [612, 792, 0, 0], -90);
  if (!pj || pj.rotate !== 270 || pj.box_mpt.join(",") !== "0,0,612000,792000") failures.push("pageFromPdfjs normalization");
  if (pageFromPdfjs(0, [0, 0, 612, 792], 45) !== null) failures.push("pageFromPdfjs accepted a 45° page");
  const viewBox = effectiveViewBox([0, 0, 612, 792], [10, 10, 700, 700]);
  if (viewBox.x !== 10 || viewBox.y !== 10 || viewBox.w !== 602 || viewBox.h !== 690) failures.push("effectiveViewBox intersection");
  const letter: SnapshotPage = { index: 0, rotate: 0, box_mpt: [0, 0, 612_000, 792_000] };
  const clamped = clampField({ page: 0, x_ppm: 990_000, y_ppm: 990_000, w_ppm: 1, h_ppm: 1, kind: "signature" }, letter);
  if (validateField({ ...clamped, kind: "signature" }, letter, 1) !== null) failures.push("clampField output fails validateField");
  return failures;
}
