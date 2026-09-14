import "server-only";
import {
  EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts, popGraphicsState, pushGraphicsState, rgb,
  type PDFFont, type PDFImage, type PDFObject, type PDFPage,
} from "pdf-lib";
import { site } from "@/lib/site";
import { EsignError } from "./errors";
import { sha256Hex } from "./hash";
import { maskPhone } from "./otp";
import type { EsignSnapshot } from "./types";

// The only pdf-lib importer. Two jobs:
//  * inspectSourcePdf: at send time, refuse files we cannot seal honestly
//    (encrypted, already digitally signed, launch actions, XFA, rich media).
//  * buildSealedPdf: at submit time, in memory, before anything is uploaded or
//    written: strip active content, flatten forms, stamp a footer on every
//    original page and append a certificate. Any throw fails the submit with
//    nothing persisted.
//
// Standard fonts encode WinAnsi only and pdf-lib throws on anything else, so
// every drawText / widthOfTextAtSize argument is a toWinAnsi() output for the
// font that draws it.

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
// it, which is why buildSealedPdf also strips active content structurally.
const BLOCKED_MARKERS: [string, string][] = [
  ["/ByteRange", "This PDF is already digitally signed, and sealing it would break that signature. Export an unsigned copy."],
  ["/Launch", "This PDF contains a launch action. Export a clean copy (Print to PDF) and upload it again."],
  ["/XFA", "This PDF is an XFA form. Export a flattened copy (Print to PDF) and upload it again."],
  ["/RichMedia", "This PDF contains embedded media. Export a clean copy (Print to PDF) and upload it again."],
];

export async function inspectSourcePdf(bytes: Uint8Array): Promise<{ ok: true; pageCount: number } | { ok: false; error: string }> {
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

    // Exercise the per-page calls buildSealedPdf relies on, so a PDF that would
    // throw at seal time is refused here, at send, instead of failing every
    // submit. This copy is discarded, so normalizing it is harmless.
    for (const page of pdf.getPages()) {
      try {
        page.getRotation();
        page.getCropBox();
        page.node.normalize();
      } catch {
        return {
          ok: false,
          error: "This PDF couldn't be prepared for signing. Export a fresh copy (Print to PDF) and upload it again.",
        };
      }
    }
    return { ok: true, pageCount };
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
  " ": " ",
};

/** Single-line text drawable by a font with `charset`: never throws inside pdf-lib. */
export function toWinAnsi(s: string, charset: ReadonlySet<number>): string {
  const normalized = String(s ?? "").normalize("NFKC").replace(/[\t\r\n]/g, " ");
  let out = "";
  for (const ch of normalized) {
    for (const c of PUNCTUATION[ch] ?? ch) {
      const cp = c.codePointAt(0) ?? 0;
      if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue;
      out += charset.has(cp) ? c : "?";
    }
  }
  return out;
}

/** Splits on line breaks BEFORE sanitizing, so each line can be measured and wrapped. */
export function winAnsiLines(s: string, charset: ReadonlySet<number>): string[] {
  return String(s ?? "").split(/\r?\n/).map((line) => toWinAnsi(line, charset));
}

// ── Sealing ─────────────────────────────────────────────────────────────────

export type SealEvent = { event: string; actor: "signer" | "staff" | "system"; at: string; ip: string | null; user_agent: string | null };
export type SealInput = {
  sourcePdf: Uint8Array; signaturePng: Uint8Array;          // FROZEN esign-bucket bytes, already re-hashed
  requestId: string; documentId: string; snapshot: EsignSnapshot;
  documentHash: string; sourceSha256: string; consentText: string; checkboxText: string;
  signerPrintedName: string; signedAt: Date; signedIp: string | null; signedUserAgent: string | null;
  sentAt: string; viewedAt: string | null; sourceOpenedAt: string | null; otpVerifiedAt: string | null;
  requireSmsOtp: boolean; events: SealEvent[];               // DB events in seq order + synthetic consented/signed
};

const N = (name: string) => PDFName.of(name);
const KEY = {
  openAction: N("OpenAction"), aa: N("AA"), names: N("Names"), javaScript: N("JavaScript"),
  embeddedFiles: N("EmbeddedFiles"), annots: N("Annots"), a: N("A"), s: N("S"), next: N("Next"),
  outlines: N("Outlines"), first: N("First"), acroForm: N("AcroForm"), fields: N("Fields"), kids: N("Kids"),
  co: N("CO"),
};
// PDFName.of interns, so identity comparison is exact.
const BLOCKED_ACTIONS = new Set(
  ["JavaScript", "Launch", "SubmitForm", "ImportData", "ResetForm", "GoToR", "GoToE", "Rendition"].map(N)
);
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
 * Catalog, page, annotation, outline (bookmark) and form-field actions. URI and
 * GoTo links survive; anything we cannot inspect is removed.
 */
function stripActiveContent(pdf: PDFDocument): boolean {
  const catalog = pdf.catalog;
  catalog.delete(KEY.openAction);
  catalog.delete(KEY.aa);
  try {
    const names = catalog.lookupMaybe(KEY.names, PDFDict);
    names?.delete(KEY.javaScript);
    names?.delete(KEY.embeddedFiles);
  } catch {
    catalog.delete(KEY.names);
  }

  for (const page of pdf.getPages()) {
    page.node.delete(KEY.aa);
    let annots;
    try {
      annots = page.node.Annots();
    } catch {
      page.node.delete(KEY.annots);
      continue;
    }
    if (!annots) continue;
    for (let idx = 0; idx < annots.size(); idx++) {
      let annot: PDFDict | undefined;
      try {
        annot = annots.lookupMaybe(idx, PDFDict);
      } catch {
        continue;
      }
      if (annot) stripAction(annot);
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
  // skipped (as pdf-lib's own field walk does) rather than ending the walk, and
  // any gap is reported so buildSealedPdf can fall back to a full sweep.
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

const ACTOR_LABEL: Record<SealEvent["actor"], string> = { signer: "Signer", staff: "GBTN", system: "System" };

const PAGE_W = 612, PAGE_H = 792;
const MARGIN = 54, BOTTOM = 72, CONTENT_W = PAGE_W - MARGIN * 2;
const LABEL_W = 150, VALUE_W = CONTENT_W - LABEL_W;
const BAND_H = 44, BAND_RULE_H = 1.5;

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

  signature(image: PDFImage): void {
    const boxW = 240, boxH = 92;
    this.ensure(boxH + 8);
    this.page.drawText(this.fit("Signature", this.bold), { x: MARGIN, y: this.y - 9, size: 8, font: this.bold, color: MUTED });
    const bx = MARGIN + LABEL_W;
    const by = this.y - boxH;
    this.page.drawRectangle({ x: bx, y: by, width: boxW, height: boxH, color: PAPER, borderColor: RULE, borderWidth: 0.75 });
    const dims = image.scaleToFit(220, 80);
    this.page.drawImage(image, {
      x: bx + (boxW - dims.width) / 2, y: by + (boxH - dims.height) / 2, width: dims.width, height: dims.height,
    });
    this.y -= boxH + 8;
  }

  auditTable(events: SealEvent[]): void {
    const cols = [
      { title: "Time (UTC)", width: 92 },
      { title: "Event", width: 96 },
      { title: "Actor", width: 40 },
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
      const isSigner = ev.actor === "signer";
      // Staff and system rows never show network details, whatever the caller passed.
      const ua = ev.user_agent && ev.user_agent.length > 70 ? `${ev.user_agent.slice(0, 69)}...` : ev.user_agent;
      const cells: string[][] = [
        this.wrap(at ? utcStamp(at).replace(" UTC", "") : "not recorded", this.regular, size, cols[0].width - 6),
        this.wrap(ev.event, this.regular, size, cols[1].width - 6),
        this.wrap(ACTOR_LABEL[ev.actor] ?? "System", this.regular, size, cols[2].width - 6),
        isSigner ? this.wrap(ev.ip ?? "not recorded", this.regular, size, cols[3].width - 6) : [this.none],
        isSigner ? this.wrap(ua ?? "not recorded", this.regular, size, cols[4].width - 6) : [this.none],
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
      // A malformed Contents entry only risks footer placement, not integrity.
    }
  }
}

export async function buildSealedPdf(i: SealInput): Promise<Uint8Array> {
  const s = i.snapshot;
  const pdf = await PDFDocument.load(i.sourcePdf, { updateMetadata: false });

  // 1. Neutralize active content, isolate the original drawing, freeze form fields.
  const fieldTreeComplete = stripActiveContent(pdf);
  isolateOriginalContent(pdf);
  const formFlattened = flattenForm(pdf);
  if (!fieldTreeComplete || formFlattened === false) stripActionsEverywhere(pdf);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let signature: PDFImage;
  try {
    signature = await pdf.embedPng(i.signaturePng);
  } catch {
    // engine.ts maps seal throws by testing the message for /png/i; keep "PNG" in it.
    throw new EsignError("signature_invalid", "The signature PNG couldn't be read. Clear the signature and sign again.");
  }

  // 2. Footer stamp on every original page (rotated pages are skipped and listed).
  const sourcePages = pdf.getPages();
  const total = sourcePages.length;
  const rotated: number[] = [];
  const footerCharset = fontCharset(regular);
  sourcePages.forEach((page, idx) => {
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    if (angle !== 0) {
      rotated.push(idx + 1);
      return;
    }
    const box = page.getCropBox();
    let text = toWinAnsi(`Electronically signed via ${site.name} e-sign  ·  Request ${i.requestId}  ·  Page ${idx + 1} of ${total}`, footerCharset);
    if (regular.widthOfTextAtSize(text, 7) > box.width - 72) {
      text = toWinAnsi(`Request ${i.requestId}  ·  Page ${idx + 1} of ${total}`, footerCharset);
    }
    page.drawText(text, { x: box.x + 36, y: box.y + 14, size: 7, font: regular, color: FOOTER_GREY });
  });

  // 3. Certificate.
  const cert = new CertificateWriter(pdf, regular, bold);
  cert.paragraph(s.document.title, { font: bold, size: 15, color: NAVY, lineHeight: 19, after: 2 });
  cert.paragraph(`Signed ${utcStamp(i.signedAt)}`, { size: 9, color: MUTED, after: 6 });

  cert.heading("Agreement");
  cert.field("Document", s.document.title);
  cert.field("Type", s.document.doc_type_label);
  cert.field("Version", String(s.document.version));
  cert.field("Effective date", s.document.effective_date ?? "Not set");
  cert.field("File name", s.source.file_name);
  cert.field("Pages", `${s.source.page_count} (followed by this certificate)`);
  cert.field("File size", `${s.source.byte_size.toLocaleString("en-US")} bytes`);
  cert.field("Engagement", s.engagement ? s.engagement.name : "None linked");

  cert.heading("Parties");
  cert.field("Provider", `${s.provider.legal_name}, doing business as ${s.provider.name}`);
  cert.field("Client", s.client.legal_name ?? s.client.name);

  cert.heading("Signer");
  cert.field("Name as sent", s.signer.name);
  cert.field("Email", s.signer.email);
  cert.field("Phone", i.requireSmsOtp ? (maskPhone(s.signer.phone_e164) ?? "not recorded") : "SMS verification not required");
  cert.field("Printed name", i.signerPrintedName);
  cert.signature(signature);
  cert.paragraph("Names are shown in Latin-1; the exact UTF-8 value is kept in the GBTN audit record.", { size: 7.5, color: MUTED });

  cert.heading("Timeline");
  cert.field("Sent", timeline(i.sentAt));
  cert.field("Viewed", timeline(i.viewedAt));
  cert.field("Document opened", timeline(i.sourceOpenedAt));
  cert.field("Identity verified", i.requireSmsOtp ? timeline(i.otpVerifiedAt) : "SMS verification not required");
  cert.field("Consented", timeline(i.signedAt));
  cert.field("Signed", timeline(i.signedAt));

  cert.heading("Signing device");
  cert.field("IP (as reported by the hosting edge)", i.signedIp ?? "not recorded");
  cert.field("User agent", i.signedUserAgent ?? "not recorded");

  cert.heading("Integrity");
  cert.field("Source document SHA-256", i.sourceSha256);
  cert.field("Consent text SHA-256", sha256Hex(i.consentText));
  cert.field("Checkbox statement SHA-256", sha256Hex(i.checkboxText));
  cert.field("Document hash", i.documentHash);
  cert.paragraph(
    "The document hash is SHA-256 over the canonical snapshot, consent text, checkbox statement and source hash (hash version 1).",
    { size: 7.5, color: MUTED }
  );
  cert.field("Request ID", i.requestId);
  cert.field("Document ID", i.documentId);
  if (rotated.length > 0) cert.paragraph(`Footer omitted on rotated pages: ${rotated.join(", ")}`);
  if (formFlattened === false) cert.paragraph("Form fields not flattened", { font: bold });

  cert.heading("Statement");
  cert.paragraph(
    "The signer checked the statement below, typed the printed name above, and drew the signature above. The pages preceding this certificate are the exact document the signer was shown, byte-identical to the source hash above. The SHA-256 of this sealed file is recorded by GBTN and included in the signer's confirmation email."
  );

  cert.heading("Audit trail");
  cert.auditTable(i.events);

  // 4. Full consent text on its own page.
  cert.newPage();
  cert.heading("Consent to electronic records and signatures (full text)");
  for (const para of i.consentText.split(/\r?\n[ \t]*\r?\n/)) {
    if (para.trim()) cert.paragraph(para, { lineHeight: 12.5, after: 7 });
  }
  cert.paragraph("Statement checked by the signer:", { font: bold, after: 2 });
  cert.paragraph(i.checkboxText, { lineHeight: 12.5 });

  // 5. Metadata. These go through PDF text strings (UTF-16), not a font.
  pdf.setTitle(`${s.document.title} (signed)`);
  pdf.setSubject(`E-signature request ${i.requestId}`);
  pdf.setProducer("GBTN e-sign (pdf-lib)");
  pdf.setCreator(site.name);
  pdf.setModificationDate(i.signedAt);

  // updateFieldAppearances:false: a form that failed to flatten must not be
  // re-rendered (or re-throw) on save.
  return await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
}
