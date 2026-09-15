import { PPM, type FieldKind, type RecipientKind, type SendFieldInput, type SnapshotPage } from "./types";
import { clampField, displayDims, pageBox, ptToPpm, userPointToPpm } from "./geometry";

// Signature-box detection over PLAIN data (S9). pdf.js runs only inside the
// sandboxed iframe; the parent receives page geometry plus text items as
// numbers and strings and runs this pure function on them. No DOM, no pdf.js
// import or types. Everything read from a PDF is data: it only ever becomes a
// label string, rendered as React text.

export type DetectTextItem = { str: string; dir: string; transform: number[]; width: number; height: number; hasEOL: boolean };
export type DetectPage = { page: SnapshotPage; items: DetectTextItem[] };
export type DraftRecipient = { key: string; kind: RecipientKind; name: string };
export type DraftField = SendFieldInput & { key: string; warn: "check_detected" | "fallback" | null };

export const DETECT_MAX_CANDIDATES = 60,
  DETECT_MAX_PLACED = 12;

/** All pages when pageCount ≤ 60, else the first 5 + last 15 (0-based). */
export function selectDetectionPages(pageCount: number): number[] {
  const n = Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : 0;
  if (n <= 60) return Array.from({ length: n }, (_, i) => i);
  return [...Array.from({ length: 5 }, (_, i) => i), ...Array.from({ length: 15 }, (_, i) => n - 15 + i)];
}

// ── Internal model (display points: origin top-left of the displayed page, y down) ──

type Glyph = { u0: number; u1: number };
type Item = { baseline: number; top: number; bottom: number; h: number; u0: number; u1: number; text: string };
type Line = {
  page: number; row: number; baseline: number; top: number; bottom: number; lineH: number;
  u0: number; u1: number; text: string; glyphs: Glyph[];
};
type PageInfo = { page: SnapshotPage; vw: number; vh: number; lines: Line[] };
type Hit = { kind: FieldKind; start: number; end: number; colon: boolean; atLineStart: boolean };
type Candidate = {
  kind: FieldKind; page: number; line: Line; labelU0: number; score: number;
  u0: number; u1: number; top: number; bottom: number; atLineStart: boolean;
};
type Block = { page: number; sig: Candidate; name: Candidate | null; date: Candidate | null; label: "client" | "provider" | null };

const SIG_RE = /(?:^|\s)(?:authori[sz]ed\s+)?signature\b|\bsign\s+here\b|\bsigned\s*:|^\s*by\s*:|\bsignatory\b|(?:^|\s)x\s*_{3,}/gi;
const NAME_RE = /\b(?:print(?:ed)?\s+name|name\s*(?:\(\s*print\s*\))?)\s*:/gi;
const DATE_RE = /(?:^|[\s(])date(?:\s+signed)?\s*:|\bdate\b\s*_{3,}/gi;
const RULE_RE = /[_＿]{5,}/g;
const NAME_REJECT_RE = /(company|client|customer|entity|legal|business|vendor|project|account|file|bank)\s+$/i;
const DATE_REJECT_RE = /(effective|start|commencement|end|termination|expiration|expiry|due|renewal|invoice|billing|birth|delivery)\s+$/i;
const PROSE_RE = /in witness whereof|counterpart|electronic signature|signature page|this signature/i;
const CLIENT_WORD_RE = /\b(client|customer|company)\b/;
const PROVIDER_WORD_RE = /\b(provider|consultant)\b/;

// ── Text → lines ────────────────────────────────────────────────────────────

function toItem(item: DetectTextItem, toView: (x: number, y: number) => { u: number; v: number }): Item | null {
  if (!item || typeof item.str !== "string" || item.dir === "ttb") return null;
  const t = item.transform;
  if (!Array.isArray(t) || t.length < 6) return null;
  const [a, b, c, d, e, f] = t;
  if (![a, b, c, d, e, f].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const text = item.str.normalize("NFKC").replace(/\s/g, " ");
  if (!text.trim()) return null;
  const advLen = Math.hypot(a, b);
  const upLen = Math.hypot(c, d);
  if (advLen === 0 || upLen === 0) return null;
  // Advance direction within 2° of an axis (page rotation is a multiple of 90°).
  const angle = (Math.atan2(b, a) * 180) / Math.PI;
  const off = ((angle % 90) + 90) % 90;
  if (Math.min(off, 90 - off) > 2) return null;
  const width = Number.isFinite(item.width) && item.width > 0 ? item.width : 0;
  const h = Number.isFinite(item.height) && item.height > 0 ? item.height : upLen;
  if (width === 0) return null;
  const ax = a / advLen, ay = b / advLen, ux = c / upLen, uy = d / upLen;
  const origin = toView(e, f);
  const end = toView(e + ax * width, f + ay * width);
  const up = toView(e + ux * h, f + uy * h);
  const du = end.u - origin.u;
  // Only text that reads left to right, upright, on the displayed page.
  if (du <= 0 || Math.abs(end.v - origin.v) > 0.1 * du || up.v >= origin.v) return null;
  const below = toView(e - ux * 0.22 * h, f - uy * 0.22 * h);
  const vs = [origin.v, end.v, up.v, below.v];
  return { baseline: origin.v, top: Math.min(...vs), bottom: Math.max(...vs), h, u0: origin.u, u1: end.u, text };
}

function appendText(line: Line, item: Item): void {
  const n = item.text.length;
  const du = item.u1 - item.u0;
  const gap = item.u0 - line.u1;
  if (line.text && gap > 0.15 * Math.max(line.lineH, item.h) && !line.text.endsWith(" ") && !item.text.startsWith(" ")) {
    line.text += " ";
    line.glyphs.push({ u0: line.u1, u1: item.u0 });
  }
  for (let k = 0; k < n; k++) {
    const ch = item.text[k];
    if (ch === " " && (line.text === "" || line.text.endsWith(" "))) continue;
    line.text += ch;
    line.glyphs.push({ u0: item.u0 + (du * k) / n, u1: item.u0 + (du * (k + 1)) / n });
  }
  line.u1 = Math.max(line.u1, item.u1);
  line.top = Math.min(line.top, item.top);
  line.bottom = Math.max(line.bottom, item.bottom);
  line.lineH = Math.max(line.lineH, item.h);
}

function pageInfo(dp: DetectPage): PageInfo | null {
  const { box, r } = pageBox(dp.page);
  const { vw, vh } = displayDims(box, r);
  if (!(vw > 0 && vh > 0)) return null;
  const toView = (x: number, y: number) => {
    const p = userPointToPpm(x, y, box, r);
    return { u: (p.u * vw) / PPM, v: (p.v * vh) / PPM };
  };

  const items: Item[] = [];
  for (const raw of Array.isArray(dp.items) ? dp.items : []) {
    const item = toItem(raw, toView);
    if (item) items.push(item);
  }
  items.sort((p, q) => p.baseline - q.baseline || p.u0 - q.u0);

  // Rows by baseline, then lines split on large horizontal gaps.
  const rows: Item[][] = [];
  let rowBase = 0, rowH = 0;
  for (const item of items) {
    const current = rows[rows.length - 1];
    if (current && Math.abs(item.baseline - rowBase) < 0.35 * Math.max(rowH, item.h)) {
      current.push(item);
      rowH = Math.max(rowH, item.h);
    } else {
      rows.push([item]);
      rowBase = item.baseline;
      rowH = item.h;
    }
  }

  const lines: Line[] = [];
  rows.forEach((row, rowIndex) => {
    row.sort((p, q) => p.u0 - q.u0);
    let line: Line | null = null;
    let previous: Item | null = null;
    for (const item of row) {
      // Fake-bold generators draw the same run twice at almost the same spot.
      if (previous && previous.text === item.text && Math.abs(previous.u0 - item.u0) < 0.5 * item.h) continue;
      if (line && item.u0 - line.u1 < 1.5 * Math.max(line.lineH, item.h)) {
        appendText(line, item);
      } else {
        if (line) lines.push(line);
        line = {
          page: dp.page.index, row: rowIndex, baseline: item.baseline, top: item.top, bottom: item.bottom,
          lineH: item.h, u0: item.u0, u1: item.u0, text: "", glyphs: [],
        };
        appendText(line, item);
      }
      previous = item;
    }
    if (line) lines.push(line);
  });
  for (const line of lines) {
    while (line.text.endsWith(" ")) {
      line.text = line.text.slice(0, -1);
      line.glyphs.pop();
    }
  }
  return { page: dp.page, vw, vh, lines: lines.filter((l) => l.text.length > 0 && l.glyphs.length === l.text.length) };
}

// ── Anchors and boxes ───────────────────────────────────────────────────────

function anchorHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(SIG_RE)) {
    const index = m.index ?? 0;
    const lead = m[0].length - m[0].trimStart().length;
    hits.push({ kind: "signature", start: index + lead, end: index + m[0].length, colon: m[0].includes(":"), atLineStart: index + lead === 0 });
  }
  for (const m of text.matchAll(NAME_RE)) {
    const index = m.index ?? 0;
    if (NAME_REJECT_RE.test(text.slice(0, index))) continue;
    hits.push({ kind: "printed_name", start: index, end: index + m[0].length, colon: true, atLineStart: text.slice(0, index).trim() === "" });
  }
  for (const m of text.matchAll(DATE_RE)) {
    const index = m.index ?? 0;
    const keyword = index + Math.max(0, m[0].toLowerCase().indexOf("date"));
    if (DATE_REJECT_RE.test(text.slice(Math.max(0, keyword - 30), keyword))) continue;
    hits.push({
      kind: "date_signed", start: keyword, end: index + m[0].length, colon: m[0].includes(":"),
      atLineStart: /^[\s(]*$/.test(text.slice(0, keyword)),
    });
  }
  return hits;
}

type RuleSpan = { start: number; end: number };

function rulesOf(line: Line, cache: Map<Line, RuleSpan[]>): RuleSpan[] {
  let rules = cache.get(line);
  if (!rules) {
    rules = [...line.text.matchAll(RULE_RE)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
    cache.set(line, rules);
  }
  return rules;
}

function spanOf(line: Line, start: number, end: number): { u0: number; u1: number } {
  const first = line.glyphs[Math.max(0, Math.min(start, line.glyphs.length - 1))];
  const last = line.glyphs[Math.max(0, Math.min(end - 1, line.glyphs.length - 1))];
  return { u0: first.u0, u1: last.u1 };
}

function candidateFor(
  info: PageInfo, line: Line, hit: Hit, cache: Map<Line, RuleSpan[]>, pageCount: number
): Candidate | null {
  const { vw, vh } = info;
  const isSignature = hit.kind === "signature";
  const label = spanOf(line, hit.start, hit.end);
  const heightFor = (lineH: number) => (isSignature ? Math.max(3.2 * lineH, 40) : 1.5 * lineH);
  const overRule = (ru: { u0: number; u1: number }, baseline: number, lineH: number) => {
    const minW = 0.18 * vw;
    const width = Math.max(ru.u1 - ru.u0, minW);
    let u0 = ru.u0;
    let u1 = u0 + width;
    if (u1 > vw) {
      u1 = vw;
      u0 = Math.max(0, vw - width);
    }
    const bottom = baseline + 0.25 * lineH;
    return { u0, u1, bottom, top: bottom - heightFor(lineH) };
  };

  let rect: { u0: number; u1: number; top: number; bottom: number } | null = null;
  let usedRule = false;

  // (a) A rule on the same line, at or after the label, with no other words in between.
  const sameLine = rulesOf(line, cache).find(
    (r) => r.start >= hit.start && !/[a-z]{3,}/i.test(line.text.slice(hit.end, Math.max(hit.end, r.start)))
  );
  if (sameLine) {
    rect = overRule(spanOf(line, sameLine.start, sameLine.end), line.baseline, line.lineH);
    usedRule = true;
  }

  // (b) A rule on a line just above that overlaps the label by more than 40%.
  if (!rect) {
    let best: { line: Line; span: { u0: number; u1: number } } | null = null;
    for (const other of info.lines) {
      if (other === line) continue;
      const dv = line.baseline - other.baseline;
      if (dv <= 0.35 * line.lineH || dv > 2.5 * Math.max(line.lineH, other.lineH)) continue;
      for (const r of rulesOf(other, cache)) {
        const span = spanOf(other, r.start, r.end);
        const overlap = Math.min(span.u1, label.u1) - Math.max(span.u0, label.u0);
        if (overlap <= 0.4 * Math.min(span.u1 - span.u0, label.u1 - label.u0)) continue;
        if (!best || other.baseline > best.line.baseline) best = { line: other, span };
      }
    }
    if (best) {
      rect = overRule(best.span, best.line.baseline, Math.max(best.line.lineH, line.lineH));
      usedRule = true;
    }
  }

  // (c) A label ending in a colon: the box starts just right of it.
  if (!rect && hit.colon) {
    const colonAt = hit.start + line.text.slice(hit.start, hit.end).lastIndexOf(":");
    const right = line.glyphs[Math.max(0, Math.min(colonAt, line.glyphs.length - 1))].u1;
    const u0 = right + 0.01 * vw;
    const width = Math.min(0.35 * vw, 0.95 * vw - u0);
    const minW = isSignature ? 90 : 50;
    if (width >= 0.5 * minW) {
      const bottom = line.baseline + 0.25 * line.lineH;
      rect = { u0, u1: u0 + width, bottom, top: bottom - heightFor(line.lineH) };
    }
  }

  // (d) A bare, short "Signature" caption under a drawn (non-text) line: box above it.
  if (!rect && isSignature && line.text.length <= 30) {
    const bottom = line.top - 0.1 * line.lineH;
    const top = bottom - heightFor(line.lineH);
    if (top >= 0) {
      rect = { u0: label.u0, u1: Math.min(vw, label.u0 + Math.max(0.25 * vw, label.u1 - label.u0)), top, bottom };
    }
  }
  if (!rect || rect.u1 - rect.u0 <= 0 || rect.bottom - rect.top <= 0) return null;

  let score = 3;
  if (usedRule) score += 2;
  if (hit.colon) score += 1;
  if ((rect.top + rect.bottom) / 2 > 0.55 * vh) score += 1;
  if (line.page === pageCount - 1) score += 1;
  if (line.text.length > 80) score -= 3;
  return {
    kind: hit.kind, page: line.page, line, labelU0: label.u0, score,
    u0: rect.u0, u1: rect.u1, top: rect.top, bottom: rect.bottom, atLineStart: hit.atLineStart,
  };
}

function iou(p: Candidate, q: Candidate): number {
  const w = Math.min(p.u1, q.u1) - Math.max(p.u0, q.u0);
  const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = (p.u1 - p.u0) * (p.bottom - p.top) + (q.u1 - q.u0) * (q.bottom - q.top) - inter;
  return union > 0 ? inter / union : 0;
}

function normalizeLabel(s: string): string {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function classifyLabel(text: string, clientNames: string[], providerNames: string[]): "client" | "provider" | null {
  const t = normalizeLabel(text);
  const strongClient = clientNames.some((n) => t.includes(n));
  const strongProvider = providerNames.some((n) => t.includes(n));
  if (strongClient !== strongProvider) return strongClient ? "client" : "provider";
  if (strongClient && strongProvider) return null;
  const weakClient = CLIENT_WORD_RE.test(t);
  const weakProvider = PROVIDER_WORD_RE.test(t);
  if (weakClient !== weakProvider) return weakClient ? "client" : "provider";
  return null;
}

// ── Detection ───────────────────────────────────────────────────────────────

export function detectFields(pages: DetectPage[], pageCount: number, opts: {
  recipients: DraftRecipient[]; clientLegalName: string; providerNames: string[]; lastPage: SnapshotPage;
}): { fields: DraftField[]; fallbackRecipientKeys: string[] } {
  const recipients = Array.isArray(opts.recipients) ? opts.recipients : [];
  if (recipients.length === 0) return { fields: [], fallbackRecipientKeys: [] };

  // 1-5. Lines, anchors, candidate boxes.
  const infos = new Map<number, PageInfo>();
  const all: Candidate[] = [];
  for (const dp of Array.isArray(pages) ? pages : []) {
    try {
      const info = pageInfo(dp);
      if (!info || infos.has(info.page.index)) continue;
      infos.set(info.page.index, info);
      const cache = new Map<Line, RuleSpan[]>();
      for (const line of info.lines) {
        const hasColon = line.text.includes(":");
        const hasRule = rulesOf(line, cache).length > 0;
        if (!hasColon && !hasRule && (line.text.length > 80 || PROSE_RE.test(line.text))) continue;
        for (const hit of anchorHits(line.text)) {
          const candidate = candidateFor(info, line, hit, cache, pageCount);
          if (candidate) all.push(candidate);
        }
      }
    } catch {
      // A malformed page is skipped; detection is a convenience, never a gate.
    }
  }

  // 6. Strongest first; drop overlapping weaker boxes of the same kind; cap.
  all.sort((p, q) => q.score - p.score || p.page - q.page || p.top - q.top || p.u0 - q.u0);
  const kept: Candidate[] = [];
  for (const c of all) {
    if (kept.some((k) => k.kind === c.kind && k.page === c.page && iou(k, c) > 0.3)) continue;
    kept.push(c);
    if (kept.length >= DETECT_MAX_CANDIDATES) break;
  }

  const readingKey = (c: Candidate) => {
    const info = infos.get(c.page);
    return info ? Math.floor(ptToPpm(c.top, info.vh) / 50_000) : 0;
  };

  // Blocks: one signature per party area (same column, within a few lines).
  const blocks: Block[] = [];
  const signatures = kept
    .filter((c) => c.kind === "signature")
    .sort((p, q) => p.page - q.page || readingKey(p) - readingKey(q) || p.labelU0 - q.labelU0);
  for (const s of signatures) {
    const info = infos.get(s.page);
    if (!info) continue;
    const same = blocks.find(
      (b) => b.page === s.page && Math.abs(b.sig.labelU0 - s.labelU0) <= 0.15 * info.vw && Math.abs(b.sig.top - s.top) <= 0.06 * info.vh
    );
    if (same) {
      if (s.score > same.sig.score) same.sig = s;
      continue;
    }
    blocks.push({ page: s.page, sig: s, name: null, date: null, label: null });
  }

  // Name and date boxes join the nearest signature block: on its row to the
  // right, or below it in the same column within 18% of the page height.
  for (const c of kept) {
    if (c.kind === "signature") continue;
    const info = infos.get(c.page);
    if (!info) continue;
    let best: Block | null = null;
    let bestDistance = Infinity;
    for (const b of blocks) {
      if (b.page !== c.page) continue;
      let distance = Infinity;
      if (c.line.row === b.sig.line.row) {
        if (c.labelU0 > b.sig.labelU0) distance = (c.labelU0 - b.sig.labelU0) / info.vw;
      } else {
        const dv = c.line.baseline - b.sig.line.baseline;
        const du = Math.abs(c.labelU0 - b.sig.labelU0);
        if (dv > 0 && dv <= 0.18 * info.vh && du <= 0.15 * info.vw) distance = dv / info.vh + du / info.vw;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = b;
      }
    }
    if (!best) continue;
    // C15: a date that doesn't start its line must sit on the signature's row or within 2 rows below it.
    if (c.kind === "date_signed" && !c.atLineStart) {
      const rows = c.line.row - best.sig.line.row;
      if (rows < 0 || rows > 2) continue;
    }
    if (c.kind === "date_signed") {
      if (!best.date || c.score > best.date.score) best.date = c;
    } else if (!best.name || c.score > best.name.score) {
      best.name = c;
    }
  }

  // 7. Party labels, nearest line first: the block's own rows, then up to 6 rows above.
  const clientNames = [normalizeLabel(opts.clientLegalName)].filter((n) => n.length >= 3);
  const providerNames = (Array.isArray(opts.providerNames) ? opts.providerNames : [])
    .map(normalizeLabel)
    .filter((n) => n.length >= 3);
  for (const b of blocks) {
    const info = infos.get(b.page);
    if (!info) continue;
    const members = [b.sig, b.name, b.date].filter((m): m is Candidate => m !== null);
    const u0 = Math.min(...members.map((m) => Math.min(m.labelU0, m.u0))) - 0.05 * info.vw;
    const u1 = Math.max(...members.map((m) => m.u1)) + 0.05 * info.vw;
    const sigRow = b.sig.line.row;
    const lastRow = Math.max(...members.map((m) => m.line.row));
    const inColumn = info.lines.filter((l) => l.u1 >= u0 && l.u0 <= u1);
    const ordered = [
      ...inColumn.filter((l) => l.row >= sigRow && l.row <= lastRow).sort((p, q) => p.row - q.row),
      ...inColumn.filter((l) => l.row < sigRow && l.row >= sigRow - 6).sort((p, q) => q.row - p.row),
    ];
    for (const l of ordered) {
      const label = classifyLabel(l.text, clientNames, providerNames);
      if (label) {
        b.label = label;
        break;
      }
    }
  }

  blocks.sort((p, q) => p.page - q.page || readingKey(p.sig) - readingKey(q.sig) || p.sig.labelU0 - q.sig.labelU0);

  // Assignment: labelled blocks first, then the rest in reading order, countersigner last.
  const assigned = new Map<string, Block>();
  const used = new Set<Block>();
  const take = (key: string, block: Block | undefined) => {
    if (!block) return;
    assigned.set(key, block);
    used.add(block);
  };
  const clientSide = recipients.filter((r) => r.kind !== "staff");
  const staff = recipients.filter((r) => r.kind === "staff");
  for (const r of clientSide) take(r.key, blocks.find((b) => !used.has(b) && b.label === "client"));
  for (const r of staff) take(r.key, blocks.find((b) => !used.has(b) && b.label === "provider"));
  for (const r of [...clientSide, ...staff]) {
    if (assigned.has(r.key)) continue;
    const pool = blocks.filter((b) => !used.has(b));
    if (r.kind === "staff") take(r.key, pool.find((b) => b.label !== "client") ?? pool[0]);
    else take(r.key, pool.find((b) => b.label !== "provider") ?? (staff.length === 0 ? pool[0] : undefined));
  }

  // 8-9. Fields: detected signatures, then name/date boxes inside the same block
  // while the auto-placement budget lasts, then fallbacks.
  const signaturesPlaced = recipients.filter((r) => assigned.has(r.key)).length;
  let budget = Math.max(0, DETECT_MAX_PLACED - signaturesPlaced);
  const extras = new Map<string, Candidate[]>();
  for (const r of recipients) {
    const block = assigned.get(r.key);
    if (!block) continue;
    const list: Candidate[] = [];
    for (const c of [block.name, block.date]) {
      if (c && budget > 0) {
        list.push(c);
        budget--;
      }
    }
    extras.set(r.key, list);
  }

  let seq = 0;
  const nextKey = () => `f${++seq}`;
  const fields: DraftField[] = [];
  const fallbackRecipientKeys: string[] = [];

  const draftFrom = (recipientKey: string, c: Candidate, warn: DraftField["warn"]): DraftField | null => {
    const info = infos.get(c.page);
    if (!info) return null;
    const x = ptToPpm(c.u0, info.vw);
    const y = ptToPpm(c.top, info.vh);
    const rect = clampField(
      { page: c.page, x_ppm: x, y_ppm: y, w_ppm: Math.max(0, ptToPpm(c.u1, info.vw) - x), h_ppm: Math.max(0, ptToPpm(c.bottom, info.vh) - y), kind: c.kind },
      info.page
    );
    return {
      key: nextKey(), recipientKey, kind: c.kind, page: rect.page,
      x_ppm: rect.x_ppm, y_ppm: rect.y_ppm, w_ppm: rect.w_ppm, h_ppm: rect.h_ppm,
      required: true, origin: "detected", detectedLabel: c.line.text.trim().slice(0, 200) || null, warn,
    };
  };

  const lastPage = opts.lastPage;
  let fallbackIndex = 0;
  const fallbackFor = (recipientKey: string): DraftField => {
    const { box, r } = pageBox(lastPage);
    const { vw, vh } = displayDims(box, r);
    const k = fallbackIndex++;
    const rect = clampField(
      {
        page: lastPage.index,
        x_ppm: k % 2 === 0 ? 80_000 : 540_000,
        y_ppm: 780_000 + Math.floor(k / 2) * 100_000,
        w_ppm: ptToPpm(180, vw),
        h_ppm: ptToPpm(44, vh),
        kind: "signature",
      },
      lastPage
    );
    return {
      key: nextKey(), recipientKey, kind: "signature", page: rect.page,
      x_ppm: rect.x_ppm, y_ppm: rect.y_ppm, w_ppm: rect.w_ppm, h_ppm: rect.h_ppm,
      required: true, origin: "detected", detectedLabel: null, warn: "fallback",
    };
  };

  for (const r of recipients) {
    const block = assigned.get(r.key);
    const signature = block ? draftFrom(r.key, block.sig, null) : null;
    if (block && signature) {
      fields.push(signature);
      for (const c of extras.get(r.key) ?? []) {
        const extra = draftFrom(r.key, c, "check_detected");
        if (extra) fields.push(extra);
      }
    } else {
      fields.push(fallbackFor(r.key));
      fallbackRecipientKeys.push(r.key);
    }
  }
  return { fields, fallbackRecipientKeys };
}
