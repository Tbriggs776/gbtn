import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { site } from "@/lib/site";
import { boxToMpt, userCornersToField, type Box } from "./geometry";
import { fontCharset, toWinAnsi } from "./seal";
import type { EsignField, FieldKind, RecipientKind, SnapshotPage } from "./types";

// Certificate mode (spec §C.3): a generated US Letter signature page that is
// SHA-256-bound to an original we cannot stamp (docx, xlsx, pptx, text, csv, or
// any file under sealing_mode 'certificate'). Its signature, printed-name and
// date boxes are ordinary EsignFields with origin 'generated', so there is ONE
// stamping path for every mode. The caller has already sniffed the original.

export const SIGPAGE_PROFILE = "sigpage-v1";

const PAGE_W = 612, PAGE_H = 792;
const MARGIN = 54, BOTTOM = 72, CONTENT_W = PAGE_W - MARGIN * 2;
const LABEL_W = 110;
const BAND_H = 44, BAND_RULE_H = 1.5;
const BLOCK_H = 120, BLOCKS_PER_PAGE = 4;
const PAGE_BOX: Box = { x: 0, y: 0, w: PAGE_W, h: PAGE_H };

const NAVY = rgb(17 / 255, 41 / 255, 74 / 255);
const CRIMSON = rgb(158 / 255, 35 / 255, 53 / 255);
const PAPER = rgb(246 / 255, 242 / 255, 234 / 255);
const RULE = rgb(231 / 255, 224 / 255, 211 / 255);
const INK = rgb(0.16, 0.18, 0.23);
const MUTED = rgb(0.42, 0.42, 0.45);
const WHITE = rgb(1, 1, 1);

type Color = ReturnType<typeof rgb>;

const KIND_LABEL: Record<RecipientKind, string> = {
  client_contact: "Client contact",
  outside: "Outside signer",
  staff: "GBTN countersigner",
};

export async function buildSignaturePage(i: {
  envelopeId: string; title: string; clientName: string; providerName: string;
  original: { fileName: string; contentTypeSniffed: string; contentTypeDeclared: string | null;
              byteSize: number; sha256: string; extension: string };
  recipients: { id: string; name: string; kind: RecipientKind; routingOrder: number }[];
  newFieldId: () => string;
}): Promise<{ pdf: Uint8Array; pages: SnapshotPage[]; fields: EsignField[] }> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const fields: EsignField[] = [];

  let page: PDFPage = pdf.addPage([PAGE_W, PAGE_H]);
  let y = 0;
  let blocksOnPage = 0;

  const draw = (s: string, x: number, baseline: number, size: number, font: PDFFont, color: Color) => {
    const t = toWinAnsi(s, fontCharset(font));
    if (t) page.drawText(t, { x, y: baseline, size, font, color });
  };

  /** Greedy wrap in the drawing font; an over-long token (a file name, a hash) breaks by character. */
  const wrap = (s: string, font: PDFFont, size: number, width: number): string[] => {
    const out: string[] = [];
    let line = "";
    for (const word of toWinAnsi(s, fontCharset(font)).split(" ").filter((w) => w.length > 0)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = "";
      for (const ch of word) {
        if (line && font.widthOfTextAtSize(line + ch, size) > width) {
          out.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
    }
    if (line) out.push(line);
    return out.length > 0 ? out : [""];
  };

  const fitOneLine = (s: string, font: PDFFont, size: number, width: number): string => {
    let t = toWinAnsi(s, fontCharset(font));
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
    return `${t.trimEnd()}...`;
  };

  const band = () => {
    page.drawRectangle({ x: 0, y: PAGE_H - BAND_H, width: PAGE_W, height: BAND_H, color: NAVY });
    page.drawRectangle({ x: 0, y: PAGE_H - BAND_H - BAND_RULE_H, width: PAGE_W, height: BAND_RULE_H, color: CRIMSON });
    draw(site.name.toUpperCase(), MARGIN, PAGE_H - BAND_H / 2 - 4, 11, bold, WHITE);
    const right = toWinAnsi("Signature page", fontCharset(regular));
    page.drawText(right, {
      x: PAGE_W - MARGIN - regular.widthOfTextAtSize(right, 10), y: PAGE_H - BAND_H / 2 - 3.5, size: 10, font: regular, color: WHITE,
    });
    y = PAGE_H - BAND_H - BAND_RULE_H - 26;
  };

  const row = (label: string, value: string, font: PDFFont = regular) => {
    const lines = wrap(value, font, 9, CONTENT_W - LABEL_W);
    draw(label, MARGIN, y - 9, 8, bold, MUTED);
    lines.forEach((line, n) => draw(line, MARGIN + LABEL_W, y - 9 - n * 12, 9, font, INK));
    y -= lines.length * 12 + 3;
  };

  const paragraph = (text: string, size: number, font: PDFFont, color: Color, lineHeight: number) => {
    for (const line of wrap(text, font, size, CONTENT_W)) {
      draw(line, MARGIN, y - size, size, font, color);
      y -= lineHeight;
    }
  };

  const newContinuationPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    band();
    blocksOnPage = 0;
    draw(fitOneLine(`${i.title} (continued)`, bold, 11, CONTENT_W), MARGIN, y - 11, 11, bold, NAVY);
    y -= 17;
    draw(`File SHA-256 ${i.original.sha256}`, MARGIN, y - 8, 8, mono, MUTED);
    y -= 20;
  };

  // ── Page 1: identity of the original, then the binding statement ──
  band();
  paragraph(i.title, 16, bold, NAVY, 20);
  y -= 2;
  paragraph("Signature page for an attached file", 9, regular, MUTED, 13);
  y -= 8;

  const ext = String(i.original.extension ?? "").replace(/^\./, "").toLowerCase();
  const declared = i.original.contentTypeDeclared?.trim() || null;
  row("Client", i.clientName);
  row("Provider", i.providerName);
  row("File name", i.original.fileName);
  row("File type", ext ? `${ext.toUpperCase()} (.${ext})` : "Unknown");
  row("Detected type", i.original.contentTypeSniffed);
  row("Declared type", declared ?? "Not recorded");
  row("File size", `${i.original.byteSize.toLocaleString("en-US")} bytes`);
  row("File SHA-256", i.original.sha256, mono);
  row("Envelope", i.envelopeId, mono);
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: RULE });
  y -= 10;
  paragraph(
    "Each signature on this page applies to the file whose SHA-256 is shown above. That file is attached, unchanged, to the sealed copy of this page.",
    9.5, bold, INK, 13.5
  );
  y -= 14;

  // ── One block per recipient: signature 240×60, printed name 240×16, date 120×16 ──
  const sorted = [...i.recipients].sort(
    (a, b) => a.routingOrder - b.routingOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const pushField = (recipientId: string, kind: FieldKind, pageIndex: number, rect: { x: number; y: number; w: number; h: number }) => {
    const f = userCornersToField(pageIndex, [{ x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y + rect.h }], PAGE_BOX, 0);
    fields.push({
      id: i.newFieldId(), recipient_id: recipientId, kind, page: f.page,
      x_ppm: f.x_ppm, y_ppm: f.y_ppm, w_ppm: f.w_ppm, h_ppm: f.h_ppm,
      required: true, origin: "generated", detected_label: null,
    });
  };

  sorted.forEach((r, idx) => {
    if (blocksOnPage >= BLOCKS_PER_PAGE || y - BLOCK_H < BOTTOM) newContinuationPage();
    const pageIndex = pdf.getPageCount() - 1;
    const top = y;
    draw(
      fitOneLine(`Signer ${idx + 1} of ${sorted.length}: ${r.name} (${KIND_LABEL[r.kind] ?? "Signer"})`, bold, 10, CONTENT_W),
      MARGIN, top - 12, 10, bold, NAVY
    );

    const sig = { x: MARGIN, y: top - 84, w: 240, h: 60 };
    page.drawRectangle({ x: sig.x, y: sig.y, width: sig.w, height: sig.h, color: PAPER, borderColor: RULE, borderWidth: 0.75 });
    draw("Signature", sig.x, sig.y - 10, 7, regular, MUTED);

    const name = { x: MARGIN + 264, y: top - 44, w: 240, h: 16 };
    page.drawLine({ start: { x: name.x, y: name.y }, end: { x: name.x + name.w, y: name.y }, thickness: 0.75, color: MUTED });
    draw("Printed name", name.x, name.y - 10, 7, regular, MUTED);

    const date = { x: MARGIN + 264, y: top - 84, w: 120, h: 16 };
    page.drawLine({ start: { x: date.x, y: date.y }, end: { x: date.x + date.w, y: date.y }, thickness: 0.75, color: MUTED });
    draw("Date signed", date.x, date.y - 10, 7, regular, MUTED);

    pushField(r.id, "signature", pageIndex, sig);
    pushField(r.id, "printed_name", pageIndex, name);
    pushField(r.id, "date_signed", pageIndex, date);

    y = top - BLOCK_H;
    blocksOnPage++;
  });

  const bytes = await pdf.save({ useObjectStreams: false });
  const pages: SnapshotPage[] = Array.from({ length: pdf.getPageCount() }, (_, index) => ({
    index, rotate: 0, box_mpt: boxToMpt(PAGE_BOX),
  }));
  return { pdf: bytes, pages, fields };
}
