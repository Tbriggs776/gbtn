import "server-only";
import { inflateRawSync } from "node:zlib";

// What a file really is, from its bytes (S6). An ALLOWLIST: PDFs and PNG/JPEG
// images can carry placed fields; clean OOXML (docx/xlsx/pptx) and plain UTF-8
// text/CSV can be signed through a certificate page. Everything else is
// refused: HTML/XHTML/SVG/XML/RTF/JSON, archives, legacy OLE .doc/.xls/.ppt,
// macro or externally-linked Office files, executables, and image formats
// pdf-lib cannot embed. The content type and extension used for downloads and
// attachments come from here, never from the uploaded file name or the
// browser's declared type.

export type SniffKind = "pdf" | "png" | "jpeg" | "docx" | "xlsx" | "pptx" | "text" | "csv";
export type Sniffed =
  | { ok: true; kind: SniffKind; contentType: string; extension: string }
  | { ok: false; code: "file_rejected" | "too_large"; error: string };

/** Certificate-mode originals only; keeps the sealed PDF (which embeds the original) attachable. */
export const ORIGINAL_MAX_BYTES_CERTIFICATE = 10_000_000;

export const SNIFF_TYPES: Record<SniffKind, { contentType: string; extension: string }> = {
  pdf: { contentType: "application/pdf", extension: "pdf" },
  png: { contentType: "image/png", extension: "png" },
  jpeg: { contentType: "image/jpeg", extension: "jpg" },
  docx: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" },
  xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" },
  pptx: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: "pptx" },
  text: { contentType: "text/plain", extension: "txt" },
  csv: { contentType: "text/csv", extension: "csv" },
};

const REFUSED_MESSAGE =
  "This file type can't be sent for signature. Upload a PDF, image, Word, Excel, PowerPoint, text or CSV file without macros or links.";
const TOO_LARGE_MESSAGE =
  "This file is larger than 10 MB, the limit for files signed with a signature page. Export a smaller copy or a PDF.";

const MAX_ZIP_ENTRIES = 5_000;
const CONTENT_TYPES_MAX = 1_000_000;
const RELS_MAX_EACH = 1_000_000;
const RELS_MAX_TOTAL = 8_000_000;
const DOCUMENT_XML_MAX = 40_000_000;

function refused(): Sniffed {
  return { ok: false, code: "file_rejected", error: REFUSED_MESSAGE };
}

function accepted(kind: SniffKind): Sniffed {
  return { ok: true, kind, ...SNIFF_TYPES[kind] };
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

function extensionOf(fileName: string): string {
  const base = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 && dot < base.length - 1 ? base.slice(dot).toLowerCase() : "";
}

// ── OOXML ───────────────────────────────────────────────────────────────────

type ZipEntry = { lower: string; method: number; compSize: number; uncompSize: number; localOffset: number };

const BLOCKED_NAME_PARTS = ["/embeddings/", "/activex/", "externallinks/", "/customui/", "oleobject"];
const BLOCKED_NAME_ENDINGS = [".exe", ".dll", ".js", ".vbs", ".hta", ".lnk"];
const RELS_EXTERNAL_RE = /TargetMode\s*=\s*["']\s*External\s*["']/i;
const RELS_BLOCKED_TYPE_RE =
  /\bType\s*=\s*["'][^"']*\/(?:attachedTemplate|oleObject|package|control|externalLink|frame|subDocument)\s*["']/i;

function scanOoxml(bytes: Uint8Array, fileName: string): SniffKind | null {
  const len = bytes.byteLength;
  if (len < 22) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => dv.getUint16(p, true);
  const u32 = (p: number) => dv.getUint32(p, true);

  // End of central directory, within the last 65 557 bytes.
  let eocd = -1;
  for (let p = len - 22, stop = Math.max(0, len - 65_557); p >= stop; p--) {
    if (u32(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) return null;
  const diskNo = u16(eocd + 4);
  const cdDisk = u16(eocd + 6);
  const onDisk = u16(eocd + 8);
  const total = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  const commentLen = u16(eocd + 20);
  if (eocd + 22 + commentLen > len) return null;
  if (diskNo !== 0 || cdDisk !== 0 || onDisk !== total) return null;
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null;  // ZIP64
  if (eocd >= 20 && u32(eocd - 20) === 0x07064b50) return null;                            // ZIP64 locator
  if (total === 0 || total > MAX_ZIP_ENTRIES) return null;
  if (cdOffset + cdSize > eocd) return null;

  const entries: ZipEntry[] = [];
  const end = cdOffset + cdSize;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > end || u32(p) !== 0x02014b50) return null;
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const uncompSize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const entryCommentLen = u16(p + 32);
    const diskStart = u16(p + 34);
    const localOffset = u32(p + 42);
    const next = p + 46 + nameLen + extraLen + entryCommentLen;
    if (next > end) return null;
    if (flags & 0x0001 || flags & 0x0040) return null;                                    // encrypted
    if (method !== 0 && method !== 8) return null;
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff || diskStart !== 0) return null;
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x0800 ? new TextDecoder("utf-8").decode(nameBytes) : latin1(nameBytes);
    entries.push({ lower: name.replace(/\\/g, "/").toLowerCase(), method, compSize, uncompSize, localOffset });
    p = next;
  }
  if (entries.length !== total) return null;
  if (new Set(entries.map((e) => e.lower)).size !== entries.length) return null;           // duplicate names hide content

  for (const e of entries) {
    const path = `/${e.lower}`;
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (path.endsWith("vbaproject.bin") || path.endsWith("vbadata.xml")) return null;
    if (BLOCKED_NAME_PARTS.some((part) => path.includes(part))) return null;
    if (path.endsWith(".bin") && !/^printersettings[^/]*\.bin$/.test(base)) return null;
    if (BLOCKED_NAME_ENDINGS.some((ending) => path.endsWith(ending))) return null;
  }

  const byName = new Map(entries.map((e) => [e.lower, e]));
  const contentTypes = byName.get("[content_types].xml");
  if (!contentTypes) return null;
  const mains = ([
    ["word/document.xml", "docx"],
    ["xl/workbook.xml", "xlsx"],
    ["ppt/presentation.xml", "pptx"],
  ] as const).filter(([name]) => byName.has(name));
  if (mains.length !== 1) return null;
  const kind: SniffKind = mains[0][1];
  if (extensionOf(fileName) !== `.${SNIFF_TYPES[kind].extension}`) return null;

  const inflate = (entry: ZipEntry, limit: number): Uint8Array | null => {
    if (entry.uncompSize > limit || entry.compSize > len) return null;
    const lh = entry.localOffset;
    if (lh + 30 > len || u32(lh) !== 0x04034b50) return null;
    const start = lh + 30 + u16(lh + 26) + u16(lh + 28);
    const stop = start + entry.compSize;
    if (stop > cdOffset) return null;
    const data = bytes.subarray(start, stop);
    if (entry.method === 0) return data.byteLength <= limit ? data : null;
    try {
      const out = inflateRawSync(data, { maxOutputLength: Math.max(1, limit) });
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } catch {
      return null;
    }
  };

  const ct = inflate(contentTypes, CONTENT_TYPES_MAX);
  if (!ct || /macroenabled/i.test(latin1(ct))) return null;

  let relsTotal = 0;
  for (const e of entries) {
    if (!e.lower.endsWith(".rels")) continue;
    const rels = inflate(e, RELS_MAX_EACH);
    if (!rels) return null;
    relsTotal += rels.byteLength;
    if (relsTotal > RELS_MAX_TOTAL) return null;
    const text = latin1(rels);
    if (RELS_EXTERNAL_RE.test(text) || RELS_BLOCKED_TYPE_RE.test(text)) return null;
  }

  if (kind === "docx") {
    const main = byName.get("word/document.xml");
    const doc = main ? inflate(main, DOCUMENT_XML_MAX) : null;
    if (!doc) return null;
    const text = latin1(doc);
    if (/\bDDEAUTO\b/i.test(text) || /instrText[\s\S]{0,40}?\bDDE\b/i.test(text)) return null;
  }
  return kind;
}

// ── Plain text ──────────────────────────────────────────────────────────────

function scanText(bytes: Uint8Array, fileName: string): SniffKind | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const ext = extensionOf(fileName);
  const kind: SniffKind | null = ext === ".txt" ? "text" : ext === ".csv" ? "csv" : null;
  if (!kind) return null;
  const head = text.slice(0, 4096).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<")) return null;
  if (["<html", "<script", "<svg", "<!doctype", "<?xml"].some((marker) => head.includes(marker))) return null;
  return kind;
}

/**
 * First match wins: %PDF- in the first 1024 bytes → pdf; PNG magic → png;
 * FF D8 FF → jpeg; a ZIP → OOXML scan; else a text scan; else refused. Placed
 * kinds have no size cap here (the engine applies the 15 MB / image caps).
 */
export function sniffFile(bytes: Uint8Array, fileName: string): Sniffed {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return refused();
  const head = bytes.subarray(0, Math.min(1024, bytes.byteLength));
  if (latin1(head).includes("%PDF-")) return accepted("pdf");
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return accepted("png");
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return accepted("jpeg");

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (bytes.byteLength > ORIGINAL_MAX_BYTES_CERTIFICATE) return { ok: false, code: "too_large", error: TOO_LARGE_MESSAGE };
    const kind = scanOoxml(bytes, fileName);
    return kind ? accepted(kind) : refused();
  }

  const kind = scanText(bytes, fileName);
  if (!kind) return refused();
  if (bytes.byteLength > ORIGINAL_MAX_BYTES_CERTIFICATE) return { ok: false, code: "too_large", error: TOO_LARGE_MESSAGE };
  return accepted(kind);
}
