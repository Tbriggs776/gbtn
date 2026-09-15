import "server-only";
import * as fontkitModule from "@pdf-lib/fontkit";
import {
  AFRelationship, EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, StandardFontEmbedder,
  StandardFonts, clip, degrees, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb,
  type PDFFont, type PDFImage, type PDFObject, type PDFPage,
} from "pdf-lib";
import { site } from "@/lib/site";
import { GREAT_VIBES_TTF_BASE64, GREAT_VIBES_TTF_SHA256 } from "./fonts/great-vibes";
import {
  MIN_PAGE_SIDE_PT, boxToMpt, displayDims, effectiveViewBox, fieldLocalToUser, fieldToUserRect, mptToBox,
  normalizeRect, normalizeRotation, pageBox, type Rect4, type UserRect,
} from "./geometry";
import { sha256Hex } from "./hash";
import { maskPhone } from "./otp";
import { originalDownloadName } from "./storage";
import {
  PPM,
  type EsignField, type EsignSnapshotV2, type FieldKind, type RecipientKind, type Rotation, type SignatureMethod,
  type SnapshotPage, type SourceMode,
} from "./types";

// The pdf-lib sealing engine. Three jobs:
//  * inspectSourcePdf: at send, refuse files we cannot seal honestly
//    (encrypted, already digitally signed, launch actions, XFA, rich media,
//    unusual page rotation or tiny pages) and report per-page geometry.
//  * probeSignaturePng / winAnsiLossless: cheap submit-time gates, so a bad
//    signature or name fails for the signer, not at seal time.
//  * buildSealedEnvelopePdf: at completion, in memory, before anything is
//    uploaded or written: strip active content, flatten forms, stamp every
//    signer's fields, footer every page, append the certificate and, in
//    certificate mode, attach the original. Any throw persists nothing.
//
// Standard fonts encode WinAnsi only and pdf-lib throws on anything else, so
// every Helvetica drawText / widthOfTextAtSize argument is a toWinAnsi()
// output. Typed signatures use the pinned Great Vibes face (server-rendered,
// I47); the signer supplies text, never a bitmap.

export const SOURCE_MAX_BYTES = 15_000_000,
  SOURCE_MAX_PAGES = 200;

type Color = ReturnType<typeof rgb>;

const NAVY = rgb(17 / 255, 41 / 255, 74 / 255);
const CRIMSON = rgb(158 / 255, 35 / 255, 53 / 255);
const PAPER = rgb(246 / 255, 242 / 255, 234 / 255);
const RULE = rgb(231 / 255, 224 / 255, 211 / 255);
const INK = rgb(0.16, 0.18, 0.23);
const MUTED = rgb(0.42, 0.42, 0.45);
const FOOTER_GREY = rgb(0.35, 0.35, 0.35);
const WHITE = rgb(1, 1, 1);

// ── Source inspection ───────────────────────────────────────────────────────

// Latin-1 byte scan. Names inside compressed object streams are invisible to
// it, which is why buildSealedEnvelopePdf also strips active content structurally.
const BLOCKED_MARKERS: [string, string][] = [
  ["/ByteRange", "This PDF is already digitally signed, and sealing it would break that signature. Export an unsigned copy."],
  ["/Launch", "This PDF contains a launch action. Export a clean copy (Print to PDF) and upload it again."],
  ["/XFA", "This PDF is an XFA form. Export a flattened copy (Print to PDF) and upload it again."],
  ["/RichMedia", "This PDF contains embedded media. Export a clean copy (Print to PDF) and upload it again."],
];

function readRect(arr: PDFArray | undefined): Rect4 | null {
  if (!arr || arr.size() !== 4) return null;
  const out: number[] = [];
  for (let k = 0; k < 4; k++) {
    const n = arr.lookup(k);
    if (!(n instanceof PDFNumber)) return null;
    out.push(n.asNumber());
  }
  return [out[0], out[1], out[2], out[3]];
}

/**
 * The page's effective view box and rotation, exactly as geometry.ts defines
 * them (and as pdf.js reports page.view / page.rotate). "rotation" = not a
 * multiple of 90; "box" = no usable MediaBox. May throw on a malformed page dict.
 */
function pageGeometry(page: PDFPage, index: number): SnapshotPage | "rotation" | "box" {
  const rotate = normalizeRotation(page.node.Rotate()?.asNumber() ?? 0);
  if (rotate === null) return "rotation";
  let media: Rect4 | null = null;
  let crop: Rect4 | null = null;
  try {
    media = readRect(page.node.MediaBox());
  } catch {
    media = null;
  }
  try {
    crop = readRect(page.node.CropBox());
  } catch {
    crop = null;
  }
  if (!media || !normalizeRect(media)) return "box";
  return { index, rotate, box_mpt: boxToMpt(effectiveViewBox(media, crop)) };
}

const PREPARE_ERROR = "This PDF couldn't be prepared for signing. Export a fresh copy (Print to PDF) and upload it again.";

/** v2: also returns per-page geometry and refuses non-90° rotation and sides < 72 pt. */
export async function inspectSourcePdf(bytes: Uint8Array):
  Promise<{ ok: true; pageCount: number; pages: SnapshotPage[] } | { ok: false; error: string }> {
  try {
    if (bytes.byteLength > SOURCE_MAX_BYTES) {
      return { ok: false, error: "This PDF is larger than 15 MB. Export a smaller copy and upload it again." };
    }
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.subarray(0, 1024).indexOf("%PDF-", 0, "latin1") === -1) {
      return { ok: false, error: "This file isn't a PDF. Upload a PDF of this agreement." };
    }

    let pdf: PDFDocument;
    try {
      pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      if (e instanceof EncryptedPDFError) {
        return { ok: false, error: "This PDF is password-protected. Export an unprotected copy and upload it again." };
      }
      return { ok: false, error: "This PDF couldn't be read. Export a fresh copy and upload it again." };
    }

    const pageCount = pdf.getPageCount();
    if (pageCount < 1) return { ok: false, error: "This PDF has no pages." };
    if (pageCount > SOURCE_MAX_PAGES) {
      return { ok: false, error: `This PDF has more than ${SOURCE_MAX_PAGES} pages, which is the limit for e-signature.` };
    }

    for (const [marker, error] of BLOCKED_MARKERS) {
      if (buf.indexOf(marker, 0, "latin1") !== -1) return { ok: false, error };
    }

    // Exercise the per-page calls the seal relies on, so a PDF that would throw
    // at seal time is refused here, at send. This copy is discarded, so
    // normalizing it is harmless.
    const pages: SnapshotPage[] = [];
    const docPages = pdf.getPages();
    for (let index = 0; index < docPages.length; index++) {
      const page = docPages[index];
      let geometry: SnapshotPage | "rotation" | "box";
      try {
        geometry = pageGeometry(page, index);
        page.getCropBox();
        page.node.normalize();
      } catch {
        return { ok: false, error: PREPARE_ERROR };
      }
      if (geometry === "rotation") {
        return {
          ok: false,
          error: "This PDF has a page turned to an angle other than 0, 90, 180 or 270 degrees. Print it to PDF and upload it again.",
        };
      }
      if (geometry === "box") {
        return { ok: false, error: "This PDF's page size couldn't be read. Print it to PDF and upload it again." };
      }
      const { vw, vh } = displayDims(mptToBox(geometry.box_mpt), geometry.rotate);
      if (vw < MIN_PAGE_SIDE_PT || vh < MIN_PAGE_SIDE_PT) {
        return { ok: false, error: "This PDF has a page smaller than 1 inch on a side, which can't hold a signature. Export a standard page size." };
      }
      pages.push(geometry);
    }
    return { ok: true, pageCount, pages };
  } catch {
    return { ok: false, error: "This PDF couldn't be read. Export a fresh copy and upload it again." };
  }
}

// ── WinAnsi text ────────────────────────────────────────────────────────────

const charsetCache = new WeakMap<PDFFont, ReadonlySet<number>>();

/** The Unicode code points this embedded font can encode, memoized per font object. */
export function fontCharset(font: PDFFont): ReadonlySet<number> {
  let charset = charsetCache.get(font);
  if (!charset) {
    charset = new Set(font.getCharacterSet());
    charsetCache.set(font, charset);
  }
  return charset;
}

const PUNCTUATION: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "–": "-", "—": "-", "−": "-",
  "…": "...",
  " ": " ",
};

function winAnsiScan(s: string, charset: ReadonlySet<number>): { text: string; lossy: boolean } {
  const normalized = String(s ?? "").normalize("NFKC").replace(/[\t\r\n]/g, " ");
  let text = "";
  let lossy = false;
  for (const ch of normalized) {
    for (const c of PUNCTUATION[ch] ?? ch) {
      const cp = c.codePointAt(0) ?? 0;
      if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
        lossy = true;
        continue;
      }
      if (charset.has(cp)) {
        text += c;
      } else {
        text += "?";
        lossy = true;
      }
    }
  }
  return { text, lossy };
}

/** Single-line text drawable by a font with `charset`: never throws inside pdf-lib. */
export function toWinAnsi(s: string, charset: ReadonlySet<number>): string {
  return winAnsiScan(s, charset).text;
}

/** Splits on line breaks BEFORE sanitizing, so each line can be measured and wrapped. */
export function winAnsiLines(s: string, charset: ReadonlySet<number>): string[] {
  return String(s ?? "").split(/\r?\n/).map((line) => toWinAnsi(line, charset));
}

let helveticaCharset: ReadonlySet<number> | null = null;

/** Helvetica's WinAnsi code points, synchronously (the embedder's encoding is what embedFont uses). */
function helveticaCodePoints(): ReadonlySet<number> {
  if (!helveticaCharset) {
    // pdf-lib types this against @pdf-lib/standard-fonts' FontNames; both enums are the string "Helvetica".
    const helvetica = StandardFonts.Helvetica as unknown as Parameters<typeof StandardFontEmbedder.for>[0];
    helveticaCharset = new Set(StandardFontEmbedder.for(helvetica).encoding.supportedCodePoints);
  }
  return helveticaCharset;
}

/** true when toWinAnsi for Helvetica would substitute no "?" and drop no character (printed names, dates). */
export function winAnsiLossless(text: string): boolean {
  return !winAnsiScan(text, helveticaCodePoints()).lossy;
}

/** true when pdf-lib can embed the PNG (full parse on a scratch document). */
export async function probeSignaturePng(bytes: Uint8Array): Promise<boolean> {
  try {
    const scratch = await PDFDocument.create({ updateMetadata: false });
    await scratch.embedPng(bytes.slice());
    return true;
  } catch {
    return false;
  }
}

// ── Typed-signature face ────────────────────────────────────────────────────

type FontkitApi = typeof fontkitModule;

/**
 * @pdf-lib/fontkit's typings declare a named `create`, but its ESM build only
 * has a default export (the UMD build is a CJS object). Resolve whichever the
 * bundler handed us.
 */
function resolveFontkit(): FontkitApi {
  const ns = fontkitModule as unknown as { create?: unknown; default?: { create?: unknown } };
  if (typeof ns.create === "function") return fontkitModule;
  if (ns.default && typeof ns.default.create === "function") return ns.default as unknown as FontkitApi;
  throw new Error("fontkit_unavailable");
}

type ScriptFace = { bytes: Uint8Array; upm: number; ascent: number; descent: number };
let greatVibesFace: ScriptFace | null = null;

/** Decoded once per process, integrity-checked against the pinned SHA-256, metrics from fontkit (C24). */
function loadGreatVibes(): ScriptFace {
  if (greatVibesFace) return greatVibesFace;
  const bytes = new Uint8Array(Buffer.from(GREAT_VIBES_TTF_BASE64, "base64"));
  if (sha256Hex(bytes) !== GREAT_VIBES_TTF_SHA256) throw new Error("font_integrity");
  const font = resolveFontkit().create(bytes);
  if (!(font.unitsPerEm > 0)) throw new Error("font_metrics");
  greatVibesFace = { bytes, upm: font.unitsPerEm, ascent: font.ascent, descent: font.descent };
  return greatVibesFace;
}

type EmbeddedScript = ScriptFace & { font: PDFFont };

/**
 * Verified by rendering "Tyler Briggs  Jane Q. Client  José Núñez" with pdf-lib
 * 1.17.1 + @pdf-lib/fontkit 1.1.1: `subset: true` (with or without features)
 * drops most Great Vibes glyphs ("Tyler Briggs" draws as "er Br"), and a full
 * embed with default OpenType features mis-shapes contextual alternates
 * ("Client" draws as "Clien t" and extracts as the wrong text). A full embed
 * with layout features off draws and extracts every character correctly. It
 * adds the whole face (~445 KB) to a sealed PDF in which someone typed.
 */
const SCRIPT_EMBED_OPTIONS = {
  subset: false,
  features: { calt: false, liga: false, clig: false, dlig: false, rlig: false, kern: false, salt: false, swsh: false },
};

/** Size and local origin for typed text centred in an (aw × ah) area; metrics from fontkit, not pdf-lib. */
function scriptLayout(text: string, script: EmbeddedScript, aw: number, ah: number, maxSize: number):
  { size: number; lx: number; ly: number } {
  const unitHeight = (script.ascent + Math.abs(script.descent)) / script.upm;
  const unitWidth = script.font.widthOfTextAtSize(text, 1);
  const size = Math.max(6, Math.min(maxSize, ah / unitHeight, unitWidth > 0 ? aw / unitWidth : maxSize));
  const height = unitHeight * size;
  const desc = (Math.abs(script.descent) / script.upm) * size;
  const width = script.font.widthOfTextAtSize(text, size);
  return { size, lx: (aw - width) / 2, ly: (ah - height) / 2 + desc };
}

// ── Sealing ─────────────────────────────────────────────────────────────────

export type SealEvent = {
  event: string; actor: "signer" | "staff" | "system"; recipientId: string | null;
  at: string; ip: string | null; user_agent: string | null;
};
export type SealRecipient = {
  id: string; kind: RecipientKind; routingOrder: number; chainIndex: number; name: string; email: string;
  phoneE164: string | null; requireSmsOtp: boolean; printedName: string; method: SignatureMethod;
  /** drawn: the frozen esign-bucket bytes, already re-hashed by the caller. */
  signaturePng: Uint8Array | null; typedText: string | null; typedFont: string | null;
  dateText: string; timeZone: string; signedAt: string;
  activatedAt: string | null; viewedAt: string | null; sourceOpenedAt: string | null;
  originalDownloadedAt: string | null; otpVerifiedAt: string | null;
  ip: string | null; userAgent: string | null;
  consentText: string; checkboxText: string; recipientHash: string; receiptSha256: string;
  appliedFieldIds: string[];
};
export type SealEnvelopeInput = {
  envelopeId: string; documentId: string; snapshot: EsignSnapshotV2;
  documentHash: string; envelopeHash: string;
  /** Frozen, re-hashed by the caller. */
  renderPdf: Uint8Array;
  /** Frozen, re-hashed; required in certificate mode, ignored otherwise. */
  originalBytes: Uint8Array | null;
  /** completedAt is the DB completing_at, never new Date(). */
  sentAt: string; completedAt: string;
  recipients: SealRecipient[]; /* chain_index asc */
  events: SealEvent[];         /* seq asc */
};

/** The frozen render disagrees with the hashed page geometry: a code regression, never signer drift. */
export class SealGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealGeometryError";
  }
}

const N = (name: string) => PDFName.of(name);
const KEY = {
  openAction: N("OpenAction"), aa: N("AA"), names: N("Names"), javaScript: N("JavaScript"),
  embeddedFiles: N("EmbeddedFiles"), annots: N("Annots"), a: N("A"), s: N("S"), next: N("Next"),
  outlines: N("Outlines"), first: N("First"), acroForm: N("AcroForm"), fields: N("Fields"), kids: N("Kids"),
  co: N("CO"), af: N("AF"), subtype: N("Subtype"),
};
// PDFName.of interns, so identity comparison is exact.
const BLOCKED_ACTIONS = new Set(
  ["JavaScript", "Launch", "SubmitForm", "ImportData", "ResetForm", "GoToR", "GoToE", "Rendition"].map(N)
);
/** Annotations that carry files or media players; removed outright (G1). */
const BLOCKED_ANNOTATION_SUBTYPES = new Set(["FileAttachment", "Sound", "Movie", "Screen", "RichMedia", "3D"].map(N));
/** Upper bound on outline items / form fields walked, against hostile or cyclic trees. */
const MAX_TREE_NODES = 20_000;

/** Removes a dict's /AA, and its /A when the action is blocked, chained, or unreadable. */
function stripAction(dict: PDFDict): void {
  dict.delete(KEY.aa);
  try {
    const action = dict.lookupMaybe(KEY.a, PDFDict);
    if (!action) return;
    const type = action.lookupMaybe(KEY.s, PDFName);
    if ((type && BLOCKED_ACTIONS.has(type)) || action.has(KEY.next)) dict.delete(KEY.a);
  } catch {
    dict.delete(KEY.a);
  }
}

/**
 * Catalog, page, annotation, outline (bookmark) and form-field actions, plus
 * file-attachment and media annotations and every /AF. URI and GoTo links
 * survive; anything we cannot inspect is removed. Returns whether the form
 * field walk completed.
 */
function stripActiveContent(pdf: PDFDocument): boolean {
  const catalog = pdf.catalog;
  catalog.delete(KEY.openAction);
  catalog.delete(KEY.aa);
  catalog.delete(KEY.af);
  try {
    const names = catalog.lookupMaybe(KEY.names, PDFDict);
    names?.delete(KEY.javaScript);
    names?.delete(KEY.embeddedFiles);
  } catch {
    catalog.delete(KEY.names);
  }

  for (const page of pdf.getPages()) {
    page.node.delete(KEY.aa);
    page.node.delete(KEY.af);
    let annots;
    try {
      annots = page.node.Annots();
    } catch {
      page.node.delete(KEY.annots);
      continue;
    }
    if (!annots) continue;
    for (let idx = annots.size() - 1; idx >= 0; idx--) {
      let annot: PDFDict | undefined;
      let subtype: PDFName | undefined;
      try {
        annot = annots.lookupMaybe(idx, PDFDict);
        subtype = annot?.lookupMaybe(KEY.subtype, PDFName);
      } catch {
        annots.remove(idx);
        continue;
      }
      if (!annot) continue;
      if (subtype && BLOCKED_ANNOTATION_SUBTYPES.has(subtype)) {
        annots.remove(idx);
        continue;
      }
      stripAction(annot);
    }
  }

  // Bookmarks can carry /A actions too. lookup returns one object per indirect
  // ref, so identity in `seen` stops cycles.
  try {
    const outlines = catalog.lookupMaybe(KEY.outlines, PDFDict);
    const first = outlines?.lookupMaybe(KEY.first, PDFDict);
    const stack: PDFDict[] = first ? [first] : [];
    const seen = new Set<PDFDict>();
    while (stack.length > 0) {
      const item = stack.pop() as PDFDict;
      if (seen.has(item)) continue;
      if (seen.size >= MAX_TREE_NODES) throw new Error("outline tree too large");
      seen.add(item);
      stripAction(item);
      const child = item.lookupMaybe(KEY.first, PDFDict);
      const sibling = item.lookupMaybe(KEY.next, PDFDict);
      if (child) stack.push(child);
      if (sibling) stack.push(sibling);
    }
  } catch {
    catalog.delete(KEY.outlines);
  }

  // Form fields (and their non-terminal parents) can carry /AA scripts that
  // page annotations never see; /CO drives calculation scripts. Bad entries are
  // skipped rather than ending the walk, and any gap is reported so the caller
  // can fall back to a full sweep.
  let fieldTreeComplete = true;
  try {
    const acroForm = catalog.lookupMaybe(KEY.acroForm, PDFDict);
    if (acroForm) {
      acroForm.delete(KEY.co);
      const stack: PDFDict[] = [];
      const pushAll = (arr: PDFObject | undefined) => {
        if (!(arr instanceof PDFArray)) return;
        for (let idx = 0; idx < arr.size(); idx++) {
          try {
            const field = arr.lookup(idx);
            if (field instanceof PDFDict) stack.push(field);
          } catch {
            fieldTreeComplete = false;
          }
        }
      };
      pushAll(acroForm.lookup(KEY.fields));
      const seen = new Set<PDFDict>();
      while (stack.length > 0) {
        const field = stack.pop() as PDFDict;
        if (seen.has(field)) continue;
        if (seen.size >= MAX_TREE_NODES) {
          fieldTreeComplete = false;
          break;
        }
        seen.add(field);
        stripAction(field);
        try {
          pushAll(field.lookup(KEY.kids));
        } catch {
          fieldTreeComplete = false;
        }
      }
    }
  } catch {
    fieldTreeComplete = false;
  }
  return fieldTreeComplete;
}

/**
 * Fail-closed fallback: every indirect dictionary loses /AA and any blocked or
 * chained /A. Used only when the field walk could not finish or the form could
 * not be flattened, so no live field script survives into the sealed copy.
 */
function stripActionsEverywhere(pdf: PDFDocument): void {
  try {
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict) stripAction(obj);
    }
  } catch {
    // stripAction already swallows per-dict lookup failures; nothing else to do.
  }
}

/** true = flattened, false = a form exists but flattening failed, null = no form. */
function flattenForm(pdf: PDFDocument): boolean | null {
  try {
    if (!pdf.catalog.getAcroForm()) return null;
  } catch {
    return false;
  }
  try {
    pdf.getForm().flatten();
    return true;
  } catch {
    return false;
  }
}

/**
 * pdf-lib draws on a loaded page by APPENDING a content stream, so a source
 * that leaves the graphics state altered (an unbalanced cm or colour) would
 * move or restyle what we draw. PDFPageLeaf.normalize() already wraps the
 * original streams in q…Q when autoNormalizeCTM is on (the 1.17.1 default);
 * this explicit wrap keeps that guarantee if the default ever changes, and the
 * extra q…Q pair is harmless. It must run before anything, form flattening
 * included, creates the page's draw stream (which then lands after the Q).
 */
function isolateOriginalContent(pdf: PDFDocument): void {
  const start = pdf.context.register(pdf.context.contentStream([pushGraphicsState()]));
  const end = pdf.context.register(pdf.context.contentStream([popGraphicsState()]));
  for (const page of pdf.getPages()) {
    try {
      if (!page.node.Contents()) continue;
      page.node.normalize();
      page.node.wrapContentStreams(start, end);
    } catch {
      // A malformed Contents entry only risks stamp placement, not integrity.
    }
  }
}

function toDate(v: string | Date | null): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const PHOENIX = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", dateStyle: "medium", timeStyle: "long" });

function timeline(v: string | Date | null): string {
  const d = toDate(v);
  return d ? `${utcStamp(d)}\n${PHOENIX.format(d)}` : "not recorded";
}

const PAGE_W = 612, PAGE_H = 792;
const MARGIN = 54, BOTTOM = 72, CONTENT_W = PAGE_W - MARGIN * 2;
const LABEL_W = 150, VALUE_W = CONTENT_W - LABEL_W;
const BAND_H = 44, BAND_RULE_H = 1.5;

const KIND_LABEL: Record<RecipientKind, string> = {
  client_contact: "Client contact",
  outside: "Outside signer",
  staff: "GBTN countersigner",
};
const FIELD_LABEL: Record<FieldKind, string> = { signature: "Signature", date_signed: "Date", printed_name: "Printed name" };
const MODE_LABEL: Record<SourceMode, string> = {
  pdf: "PDF",
  image_pdf: "Converted image",
  certificate: "Signature page for attached file",
};
const NETWORK_WITHHELD = "Recorded by GBTN; withheld from this certificate";

/** A y-cursor over US Letter certificate pages; every string is sanitized for the font that draws it. */
class CertificateWriter {
  page!: PDFPage;
  y = 0;
  /** Em dash when the font has it; drawn as-is because toWinAnsi deliberately folds dashes to "-". */
  readonly none: string;

  constructor(private readonly pdf: PDFDocument, private readonly regular: PDFFont, private readonly bold: PDFFont) {
    this.none = fontCharset(regular).has(0x2014) ? "—" : "-";
    this.newPage();
  }

  newPage(): void {
    const page = this.pdf.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: PAGE_H - BAND_H, width: PAGE_W, height: BAND_H, color: NAVY });
    page.drawRectangle({ x: 0, y: PAGE_H - BAND_H - BAND_RULE_H, width: PAGE_W, height: BAND_RULE_H, color: CRIMSON });
    page.drawText(this.fit(site.name.toUpperCase(), this.bold), {
      x: MARGIN, y: PAGE_H - BAND_H / 2 - 4, size: 11, font: this.bold, color: WHITE,
    });
    const right = this.fit("Certificate of Electronic Signature", this.regular);
    page.drawText(right, {
      x: PAGE_W - MARGIN - this.regular.widthOfTextAtSize(right, 10), y: PAGE_H - BAND_H / 2 - 3.5,
      size: 10, font: this.regular, color: WHITE,
    });
    this.page = page;
    this.y = PAGE_H - BAND_H - BAND_RULE_H - 26;
  }

  ensure(height: number): void {
    if (this.y - height < BOTTOM) this.newPage();
  }

  fit(s: string, font: PDFFont): string {
    return toWinAnsi(s, fontCharset(font));
  }

  /** Greedy word wrap; an over-long token (hash, user agent) is broken by character. */
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const raw of winAnsiLines(text, fontCharset(font))) {
      const words = raw.split(" ").filter((w) => w.length > 0);
      if (words.length === 0) {
        out.push("");
        continue;
      }
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) out.push(line);
        if (font.widthOfTextAtSize(word, size) <= width) {
          line = word;
          continue;
        }
        let chunk = "";
        for (const ch of word) {
          if (chunk && font.widthOfTextAtSize(chunk + ch, size) > width) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      }
      if (line) out.push(line);
    }
    return out;
  }

  paragraph(text: string, opts: { font?: PDFFont; size?: number; color?: Color; lineHeight?: number; after?: number } = {}): void {
    const font = opts.font ?? this.regular;
    const size = opts.size ?? 9;
    const lineHeight = opts.lineHeight ?? size * 1.4;
    for (const line of this.wrap(text, font, size, CONTENT_W)) {
      this.ensure(lineHeight);
      if (line) this.page.drawText(line, { x: MARGIN, y: this.y - size, size, font, color: opts.color ?? INK });
      this.y -= lineHeight;
    }
    this.y -= opts.after ?? 4;
  }

  heading(title: string): void {
    this.ensure(56);
    this.y -= 8;
    this.page.drawText(this.fit(title, this.bold), { x: MARGIN, y: this.y - 11, size: 11, font: this.bold, color: NAVY });
    this.y -= 17;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.5, color: RULE });
    this.y -= 8;
  }

  field(label: string, value: string): void {
    const labels = this.wrap(label, this.bold, 8, LABEL_W - 10);
    const values = this.wrap(value, this.regular, 9, VALUE_W);
    const height = Math.max(labels.length, values.length) * 12;
    this.ensure(height);
    labels.forEach((line, n) => {
      if (line) this.page.drawText(line, { x: MARGIN, y: this.y - 9 - n * 12, size: 8, font: this.bold, color: MUTED });
    });
    values.forEach((line, n) => {
      if (line) this.page.drawText(line, { x: MARGIN + LABEL_W, y: this.y - 9 - n * 12, size: 9, font: this.regular, color: INK });
    });
    this.y -= height + 3;
  }

  /** A labelled paper box; `draw` receives the inner area (x, y, w, h) on the current page. */
  signatureBox(label: string, draw: (page: PDFPage, x: number, y: number, w: number, h: number) => void): void {
    const boxW = 240, boxH = 92;
    this.ensure(boxH + 8);
    this.page.drawText(this.fit(label, this.bold), { x: MARGIN, y: this.y - 9, size: 8, font: this.bold, color: MUTED });
    const bx = MARGIN + LABEL_W;
    const by = this.y - boxH;
    this.page.drawRectangle({ x: bx, y: by, width: boxW, height: boxH, color: PAPER, borderColor: RULE, borderWidth: 0.75 });
    draw(this.page, bx + 10, by + 6, boxW - 20, boxH - 12);
    this.y -= boxH + 8;
  }

  auditTable(events: SealEvent[], who: (ev: SealEvent) => { label: string; network: boolean }): void {
    const cols = [
      { title: "Time (UTC)", width: 92 },
      { title: "Event", width: 96 },
      { title: "Who", width: 40 },
      { title: "IP", width: 78 },
      { title: "User agent", width: CONTENT_W - 306 },
    ];
    const size = 7, lineHeight = 9;
    const header = () => {
      this.ensure(16 + lineHeight);
      let x = MARGIN;
      for (const col of cols) {
        this.page.drawText(this.fit(col.title, this.bold), { x, y: this.y - size, size, font: this.bold, color: MUTED });
        x += col.width;
      }
      this.y -= 11;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.5, color: RULE });
      this.y -= 3;
    };
    header();

    for (const ev of events) {
      const at = toDate(ev.at);
      const actor = who(ev);
      // Staff and system rows, and a staff countersigner's own rows, never show network details.
      const ua = ev.user_agent && ev.user_agent.length > 70 ? `${ev.user_agent.slice(0, 69)}...` : ev.user_agent;
      const cells: string[][] = [
        this.wrap(at ? utcStamp(at).replace(" UTC", "") : "not recorded", this.regular, size, cols[0].width - 6),
        this.wrap(ev.event, this.regular, size, cols[1].width - 6),
        this.wrap(actor.label, this.regular, size, cols[2].width - 6),
        actor.network ? this.wrap(ev.ip ?? "not recorded", this.regular, size, cols[3].width - 6) : [this.none],
        actor.network ? this.wrap(ua ?? "not recorded", this.regular, size, cols[4].width - 6) : [this.none],
      ];
      const height = Math.max(...cells.map((c) => c.length)) * lineHeight + 3;
      if (this.y - height < BOTTOM) {
        this.newPage();
        header();
      }
      let x = MARGIN;
      cells.forEach((lines, c) => {
        lines.forEach((line, n) => {
          if (line) this.page.drawText(line, { x, y: this.y - size - n * lineHeight, size, font: this.regular, color: INK });
        });
        x += cols[c].width;
      });
      this.y -= height;
    }
  }
}

type StampContext = {
  regular: PDFFont;
  script: EmbeddedScript | null;
  images: Map<string, PDFImage>;
};

/** Stamps one field, clipped to its rectangle, upright on the displayed page (§A.1 local transform). */
function stampField(page: PDFPage, sp: SnapshotPage, field: EsignField, recipient: SealRecipient, ctx: StampContext): void {
  const { box, r } = pageBox(sp);
  const { vw: VW, vh: VH } = displayDims(box, r);
  const rect = fieldToUserRect(field, box, r);
  const fw = (field.w_ppm * VW) / PPM;
  const fh = (field.h_ppm * VH) / PPM;
  const pad = Math.min(4, Math.max(1, 0.06 * Math.min(fw, fh)));
  const aw = fw - 2 * pad;
  const ah = fh - 2 * pad;
  if (!(aw > 0 && ah > 0)) return;
  const rotate = degrees(r);

  page.pushOperators(pushGraphicsState(), rectangle(rect.ux, rect.uy, rect.uw, rect.uh), clip(), endPath());

  if (field.kind === "signature" && recipient.method === "drawn") {
    const image = ctx.images.get(recipient.id);
    if (!image) throw new Error("signature_image_missing");
    const dims = image.scaleToFit(aw, ah);
    const at = fieldLocalToUser(pad + (aw - dims.width) / 2, pad, rect, r);
    page.drawImage(image, { x: at.x, y: at.y, width: dims.width, height: dims.height, rotate });
  } else if (field.kind === "signature") {
    if (!ctx.script || !recipient.typedText) throw new Error("typed_signature_missing");
    const layout = scriptLayout(recipient.typedText, ctx.script, aw, ah, 36);
    const at = fieldLocalToUser(pad + layout.lx, pad + layout.ly, rect, r);
    page.drawText(recipient.typedText, { x: at.x, y: at.y, size: layout.size, font: ctx.script.font, color: INK, rotate });
  } else {
    const font = ctx.regular;
    const text = toWinAnsi(field.kind === "date_signed" ? recipient.dateText : recipient.printedName, fontCharset(font));
    if (text) {
      const unitWidth = font.widthOfTextAtSize(text, 1);
      const size = Math.max(6, Math.min(10, ah / font.heightAtSize(1), unitWidth > 0 ? aw / unitWidth : 10));
      const height = font.heightAtSize(size);
      const desc = height - font.heightAtSize(size, { descender: false });
      const at = fieldLocalToUser(pad, pad + (ah - height) / 2 + desc, rect, r);
      page.drawText(text, { x: at.x, y: at.y, size, font, color: INK, rotate });
    }
  }

  page.pushOperators(popGraphicsState());
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pageRect(sp: SnapshotPage): { rect: UserRect; r: Rotation } {
  const { box, r } = pageBox(sp);
  return { rect: { ux: box.x, uy: box.y, uw: box.w, uh: box.h }, r };
}

export async function buildSealedEnvelopePdf(i: SealEnvelopeInput): Promise<Uint8Array> {
  const s = i.snapshot;
  const recipients = [...i.recipients].sort((a, b) => a.chainIndex - b.chainIndex || compareIds(a.id, b.id));
  const byId = new Map(recipients.map((r) => [r.id, r]));
  const total = recipients.length;

  const pdf = await PDFDocument.load(i.renderPdf, { updateMetadata: false });

  // Geometry gate (I43), before anything mutates the document.
  const pages = pdf.getPages();
  if (pages.length !== s.pages.length || pages.length !== s.render.page_count) throw new SealGeometryError("page_count");
  pages.forEach((page, idx) => {
    const expected = s.pages[idx];
    let actual: SnapshotPage | "rotation" | "box";
    try {
      actual = pageGeometry(page, idx);
    } catch {
      throw new SealGeometryError("page_unreadable");
    }
    if (
      typeof actual === "string" || !expected || expected.index !== idx || actual.rotate !== expected.rotate ||
      actual.box_mpt.some((v, k) => v !== expected.box_mpt[k])
    ) {
      throw new SealGeometryError("page_geometry");
    }
  });
  for (const f of s.fields) {
    if (!Number.isSafeInteger(f.page) || f.page < 0 || f.page >= pages.length) throw new SealGeometryError("field_page");
    if (!byId.has(f.recipient_id)) throw new Error("field_recipient_missing");
  }

  // 1. Neutralize active content, isolate the original drawing, freeze form fields.
  const fieldTreeComplete = stripActiveContent(pdf);
  isolateOriginalContent(pdf);
  const formFlattened = flattenForm(pdf);
  if (!fieldTreeComplete || formFlattened === false) stripActionsEverywhere(pdf);

  // 3. Fonts. The script face is embedded only when someone typed.
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let script: EmbeddedScript | null = null;
  if (recipients.some((r) => r.method === "typed")) {
    const face = loadGreatVibes();
    pdf.registerFontkit(resolveFontkit() as unknown as Parameters<PDFDocument["registerFontkit"]>[0]);
    script = { ...face, font: await pdf.embedFont(face.bytes, SCRIPT_EMBED_OPTIONS) };
  }

  // 4. One embedded image per drawn signer, reused for every field and the certificate.
  const images = new Map<string, PDFImage>();
  for (const r of recipients) {
    if (r.method === "drawn") {
      if (!r.signaturePng) throw new Error("signature_image_missing");
      images.set(r.id, await pdf.embedPng(r.signaturePng.slice()));
    } else if (!r.typedText) {
      throw new Error("typed_signature_missing");
    }
  }

  // 5. Stamp: page asc, then signer chain_index, then field id. Signature boxes
  // only where that signer applied them (S5); date and name boxes always.
  const stamped: { field: EsignField; recipient: SealRecipient }[] = [];
  const ordered = [...s.fields].sort(
    (a, b) =>
      a.page - b.page ||
      (byId.get(a.recipient_id)?.chainIndex ?? 0) - (byId.get(b.recipient_id)?.chainIndex ?? 0) ||
      compareIds(a.id, b.id)
  );
  const ctx: StampContext = { regular, script, images };
  for (const field of ordered) {
    const recipient = byId.get(field.recipient_id);
    if (!recipient) continue;
    if (field.kind === "signature" && !recipient.appliedFieldIds.includes(field.id)) continue;
    stampField(pages[field.page], s.pages[field.page], field, recipient, ctx);
    stamped.push({ field, recipient });
  }

  // 6. Footer on every render page, rotated pages included.
  const footerCharset = fontCharset(regular);
  pages.forEach((page, idx) => {
    const { rect, r } = pageRect(s.pages[idx]);
    const { vw } = displayDims(mptToBox(s.pages[idx].box_mpt), r);
    let text = toWinAnsi(
      `Electronically signed via ${site.name} e-sign  ·  Envelope ${i.envelopeId}  ·  Page ${idx + 1} of ${pages.length}`,
      footerCharset
    );
    if (regular.widthOfTextAtSize(text, 7) > vw - 72) {
      text = toWinAnsi(`Envelope ${i.envelopeId}  ·  Page ${idx + 1} of ${pages.length}`, footerCharset);
    }
    const at = fieldLocalToUser(36, 14, rect, r);
    page.drawText(text, { x: at.x, y: at.y, size: 7, font: regular, color: FOOTER_GREY, rotate: degrees(r) });
  });

  // 7. Certificate.
  const cert = new CertificateWriter(pdf, regular, bold);
  const completed = toDate(i.completedAt);
  cert.paragraph(s.document.title, { font: bold, size: 15, color: NAVY, lineHeight: 19, after: 2 });
  cert.paragraph(completed ? `Completed ${utcStamp(completed)}` : "Completed", { size: 9, color: MUTED, after: 6 });

  const ext = s.source.extension.replace(/^\./, "").toLowerCase();
  cert.heading("Agreement");
  cert.field("Document", s.document.title);
  cert.field("Type", s.document.doc_type_label);
  cert.field("Version", String(s.document.version));
  cert.field("Effective date", s.document.effective_date ?? "Not set");
  cert.field("Engagement", s.engagement ? s.engagement.name : "None linked");
  cert.field("Kind", MODE_LABEL[s.mode] ?? s.mode);
  cert.field("Original file name", s.source.file_name);
  cert.field(
    "Original file type",
    `${ext ? `${ext.toUpperCase()} (.${ext}), ` : ""}${s.source.content_type_sniffed}` +
      (s.source.content_type_declared && s.source.content_type_declared !== s.source.content_type_sniffed
        ? `; declared as ${s.source.content_type_declared}`
        : "")
  );
  cert.field("Original size", `${s.source.byte_size.toLocaleString("en-US")} bytes`);
  cert.field("Original SHA-256", s.source.sha256);
  const conversion = s.render.conversion;
  if (conversion?.profile === "img2pdf-v1") {
    cert.field(
      "Conversion",
      `${conversion.profile} with ${conversion.tool}: ${conversion.pixel_w} × ${conversion.pixel_h} px, EXIF orientation ${conversion.orientation}`
    );
  } else if (conversion?.profile === "sigpage-v1") {
    cert.field("Conversion", `${conversion.profile} with ${conversion.tool}: signature page generated by GBTN`);
  }
  cert.field("Pages", `${s.render.page_count} (followed by this certificate)`);
  if (s.mode === "certificate") cert.field("Attached file", "The original file is attached to this PDF, unchanged.");

  cert.heading("Parties");
  cert.field("Provider", `${s.provider.legal_name}, doing business as ${s.provider.name}`);
  cert.field("Client", s.client.legal_name ?? s.client.name);

  cert.heading("Envelope");
  cert.field("Routing", s.routing === "sequential" ? "Sequential (each signer in turn)" : "Parallel (all signers at once)");
  cert.field("Sent", timeline(i.sentAt));
  cert.field("Completed", timeline(i.completedAt));
  cert.field("Signers", String(total));

  const fieldsSignedBy = (r: SealRecipient) =>
    stamped
      .filter((x) => x.recipient.id === r.id)
      .map((x) => `${FIELD_LABEL[x.field.kind]} p.${x.field.page + 1}`)
      .join(", ") || "None";

  for (const r of recipients) {
    cert.heading(`Signer ${r.chainIndex} of ${total} — ${KIND_LABEL[r.kind] ?? "Signer"}`);
    cert.field("Name as sent", r.name);
    cert.field("Email", r.email);
    cert.field("Phone", r.requireSmsOtp ? (maskPhone(r.phoneE164) ?? "not recorded") : "SMS verification not required");
    if (s.routing === "sequential") cert.field("Signing order", String(r.routingOrder));
    cert.field("Printed name", r.printedName);
    cert.field("Method", r.method === "drawn" ? "Drawn" : `Typed ("${r.typedText ?? ""}", Great Vibes)`);
    const image = images.get(r.id);
    if (r.method === "drawn" && image) {
      cert.signatureBox("Signature", (page, x, y, w, h) => {
        const dims = image.scaleToFit(w, h);
        page.drawImage(image, { x: x + (w - dims.width) / 2, y: y + (h - dims.height) / 2, width: dims.width, height: dims.height });
      });
    } else if (r.method === "typed" && script && r.typedText) {
      const face = script;
      const text = r.typedText;
      cert.signatureBox("Signature", (page, x, y, w, h) => {
        const layout = scriptLayout(text, face, w, h, 36);
        page.drawText(text, { x: x + layout.lx, y: y + layout.ly, size: layout.size, font: face.font, color: INK });
      });
    }
    cert.field("Fields signed", fieldsSignedBy(r));
    cert.field("Sent / activated", timeline(r.activatedAt ?? i.sentAt));
    cert.field("Viewed", timeline(r.viewedAt));
    cert.field("Document opened", timeline(r.sourceOpenedAt));
    if (s.mode === "certificate") cert.field("Original downloaded", timeline(r.originalDownloadedAt));
    if (r.requireSmsOtp) cert.field("SMS verified", timeline(r.otpVerifiedAt));
    cert.field("Consented", timeline(r.signedAt));
    cert.field("Signed", timeline(r.signedAt));
    cert.field("Date shown", `${r.dateText} (${r.timeZone})`);
    if (r.kind === "staff") {
      cert.field("IP", NETWORK_WITHHELD);
      cert.field("User agent", NETWORK_WITHHELD);
    } else {
      cert.field("IP (as reported by the hosting edge)", r.ip ?? "not recorded");
      cert.field("User agent", r.userAgent ?? "not recorded");
    }
    cert.field("Receipt SHA-256", r.receiptSha256);
  }
  cert.paragraph("Names are shown in Latin-1; the exact UTF-8 values are kept in the GBTN audit record.", { size: 7.5, color: MUTED });

  cert.heading("Placement");
  if (stamped.length === 0) cert.paragraph("No fields were stamped.");
  for (const { field, recipient } of stamped) {
    const { box, r } = pageBox(s.pages[field.page]);
    const { vw, vh } = displayDims(box, r);
    const pt = (ppm: number, side: number) => ((ppm * side) / PPM).toFixed(1);
    cert.field(
      `Signer ${recipient.chainIndex} · ${FIELD_LABEL[field.kind]} · page ${field.page + 1}`,
      `x ${pt(field.x_ppm, vw)}, y ${pt(field.y_ppm, vh)}, ${pt(field.w_ppm, vw)} × ${pt(field.h_ppm, vh)} pt from the top-left of the page as displayed`
    );
  }

  cert.heading("Integrity");
  cert.field("Render SHA-256", s.render.sha256);
  cert.field("Original SHA-256", s.source.sha256);
  for (const r of recipients) {
    cert.field(`Signer ${r.chainIndex} consent text SHA-256`, sha256Hex(r.consentText));
    cert.field(`Signer ${r.chainIndex} checkbox statement SHA-256`, sha256Hex(r.checkboxText));
    cert.field(`Signer ${r.chainIndex} recipient hash`, r.recipientHash);
  }
  cert.field("Document hash", i.documentHash);
  cert.paragraph(
    "The document hash is SHA-256 over the canonical envelope snapshot: the document, the original and rendered files, every page's geometry, the signers and every field box (hash version 2).",
    { size: 7.5, color: MUTED }
  );
  for (const r of recipients) cert.field(`Receipt ${r.chainIndex}`, r.receiptSha256);
  cert.paragraph(
    "Each receipt covers the document hash, the signer's hash, the previous receipt, the signature, printed name, date, time zone, network details and the boxes that signer applied.",
    { size: 7.5, color: MUTED }
  );
  cert.field("Envelope hash", i.envelopeHash);
  cert.paragraph("The envelope hash is SHA-256 over the document hash and the receipts in chain order.", { size: 7.5, color: MUTED });
  cert.field("Envelope ID", i.envelopeId);
  cert.field("Document ID", i.documentId);
  if (formFlattened === false) cert.paragraph("Form fields not flattened", { font: bold });

  cert.heading("Statement");
  const shared =
    "Each signer checked the statement shown on the consent page, typed the printed name above, and signed by the method shown for that signer. Each signature, printed name and date was stamped into the boxes listed under Placement. The SHA-256 of this sealed file is recorded by GBTN and included in the completion email.";
  if (s.mode === "image_pdf") {
    cert.paragraph(
      `The pages preceding this certificate were produced by GBTN from the original image identified above (profile img2pdf-v1). ${shared}`
    );
  } else if (s.mode === "certificate") {
    cert.paragraph(
      `The attached file is byte-identical to the original SHA-256 above; each signature above applies to it. ${shared}`
    );
  } else {
    cert.paragraph(
      `The pages preceding this certificate are the exact document the signers were shown, byte-identical to the render hash above. ${shared}`
    );
  }

  cert.heading("Audit trail");
  cert.auditTable(i.events, (ev) => {
    if (ev.actor === "staff") return { label: "GBTN", network: false };
    if (ev.actor === "system") return { label: "System", network: false };
    const r = ev.recipientId ? byId.get(ev.recipientId) : undefined;
    if (!r) return { label: "Signer", network: true };
    return { label: `S${r.chainIndex}`, network: r.kind !== "staff" };
  });

  // Full consent text, once per distinct consent + checkbox pair.
  const consentGroups = new Map<string, { consent: string; checkbox: string; signers: number[] }>();
  for (const r of recipients) {
    const key = `${sha256Hex(r.consentText)}:${sha256Hex(r.checkboxText)}`;
    const group = consentGroups.get(key);
    if (group) group.signers.push(r.chainIndex);
    else consentGroups.set(key, { consent: r.consentText, checkbox: r.checkboxText, signers: [r.chainIndex] });
  }
  for (const group of consentGroups.values()) {
    cert.newPage();
    cert.heading("Consent to electronic records and signatures (full text)");
    cert.paragraph(`Shown to: ${group.signers.map((n) => `Signer ${n}`).join(", ")}`, { size: 8, color: MUTED, after: 6 });
    for (const para of group.consent.split(/\r?\n[ \t]*\r?\n/)) {
      if (para.trim()) cert.paragraph(para, { lineHeight: 12.5, after: 7 });
    }
    cert.paragraph("Statement checked by the signer:", { font: bold, after: 2 });
    cert.paragraph(group.checkbox, { lineHeight: 12.5 });
  }

  // 8. Certificate mode: attach the original (after stripping, so ours is the only embedded file).
  if (s.mode === "certificate") {
    if (!i.originalBytes) throw new Error("original_missing");
    if (sha256Hex(i.originalBytes) !== s.source.sha256) throw new Error("original_hash_mismatch");
    const sent = toDate(i.sentAt) ?? undefined;
    await pdf.attach(i.originalBytes, originalDownloadName(s.document.title, s.source.extension), {
      mimeType: s.source.content_type_sniffed,
      description: `Original document. SHA-256 ${s.source.sha256}`,
      creationDate: sent,
      modificationDate: sent,
      afRelationship: AFRelationship.Source,
    });
  }

  // 9. Metadata (PDF text strings, UTF-16, not a font) and save.
  pdf.setTitle(`${s.document.title} (signed)`);
  pdf.setSubject(`E-signature envelope ${i.envelopeId}`);
  pdf.setProducer("GBTN e-sign (pdf-lib)");
  pdf.setCreator(site.name);
  pdf.setModificationDate(completed ?? new Date(0));

  // updateFieldAppearances:false: a form that failed to flatten must not be
  // re-rendered (or re-throw) on save.
  return await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}
