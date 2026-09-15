import "server-only";
import { PDFDocument, PDFRawStream, concatTransformationMatrix, degrees, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";
import { imagePageLayout } from "./geometry";
import { SOURCE_MAX_BYTES } from "./seal";

// Image → PDF with pdf-lib only (no native image libraries, no converter
// service). The header walk is ours and bounds-checked, because pdf-lib's JPEG
// parser has no bounds checks and its PNG path fully decodes the image. Caps
// (S10/C13/C14) bound decode memory and keep the render under the 15 MB source
// limit; the engine still runs inspectSourcePdf on the result's structure
// (convertedStructureProbe), never on the raw image bytes.
//
// EXIF orientation is honoured exactly as the browser's default
// image-orientation: from-image does, and both sides lay out through
// geometry.imagePageLayout, so staff boxes land on the same pixels.

export const IMAGE_PROFILE = "img2pdf-v1";
export const IMAGE_INPUT_MAX_BYTES = 14_000_000;
/** width · height · channels (gray 1, RGB 3, RGBA 4, palette 3, or 4 with tRNS). */
export const PNG_MAX_RAW_BYTES = 12_000_000;
export const PNG_MAX_SIDE = 8_000;
export const JPEG_MAX_PIXELS = 20_000_000;
export const JPEG_MAX_SIDE = 12_000;

export type ImageHeader = {
  kind: "png" | "jpeg"; pixelW: number; pixelH: number; orientation: number;
  displayW: number; displayH: number; channels: number;
};

const UNREADABLE = "This image can't be read. Export it as an 8-bit JPEG or PNG and upload it again.";
const INPUT_TOO_LARGE = "This image is larger than 14 MB. Export a smaller JPEG and upload it again.";
const TOO_LARGE_FOR_PAGE = "This image is too large to sign on the page. Export it as a JPEG under 14 MB.";

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end && i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function readPngHeader(b: Uint8Array): ImageHeader | null {
  const len = b.byteLength;
  if (len < 33) return null;
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < magic.length; i++) if (b[i] !== magic[i]) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(8) !== 13 || ascii(b, 12, 16) !== "IHDR") return null;
  const w = dv.getUint32(16);
  const h = dv.getUint32(20);
  const depth = b[24], color = b[25], compression = b[26], filter = b[27], interlace = b[28];
  if (w === 0 || h === 0 || depth !== 8 || ![0, 2, 3, 6].includes(color) || compression !== 0 || filter !== 0 || interlace !== 0) {
    return null;
  }
  // acTL (animation) and tRNS must both precede the first IDAT.
  let hasTrns = false;
  let p = 33;
  while (p + 8 <= len) {
    const chunkLen = dv.getUint32(p);
    const type = ascii(b, p + 4, p + 8);
    if (type === "acTL") return null;
    if (type === "tRNS") hasTrns = true;
    if (type === "IDAT" || type === "IEND") break;
    if (chunkLen > 0x7fffffff || p + 12 + chunkLen > len) return null;
    p += 12 + chunkLen;
  }
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 6 ? 4 : hasTrns ? 4 : 3;
  return { kind: "png", pixelW: w, pixelH: h, orientation: 1, displayW: w, displayH: h, channels };
}

function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (end - start < 14 || ascii(b, start, start + 6) !== "Exif\0\0") return 1;
  const t = start + 6;
  const little = b[t] === 0x49 && b[t + 1] === 0x49 && b[t + 2] === 0x2a && b[t + 3] === 0x00;
  const big = b[t] === 0x4d && b[t + 1] === 0x4d && b[t + 2] === 0x00 && b[t + 3] === 0x2a;
  if (!little && !big) return 1;
  const r16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const r32 = (o: number) =>
    (little ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (t + 8 > end) return 1;
  const ifd = t + r32(t + 4);
  if (ifd < t + 8 || ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return 1;
    if (r16(e) !== 0x0112) continue;
    if (r16(e + 2) !== 3 || r32(e + 4) !== 1) return 1;
    const v = r16(e + 8);
    return v >= 1 && v <= 8 ? v : 1;
  }
  return 1;
}

const JPEG_REFUSED_SOF = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readJpegHeader(b: Uint8Array): ImageHeader | null {
  const len = b.byteLength;
  if (len < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  let sof: { w: number; h: number; precision: number; comps: number } | null = null;
  let sofCount = 0;
  let adobe = false;
  let orientation = 1;
  let exifSeen = false;
  let reachedScan = false;
  while (p < len) {
    if (b[p] !== 0xff) return null;
    while (p < len && b[p] === 0xff) p++;
    if (p >= len) return null;
    const marker = b[p++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8 || marker === 0xd9) return null;
    if (p + 2 > len) return null;
    const segLen = (b[p] << 8) | b[p + 1];
    const segStart = p + 2;
    const segEnd = p + segLen;
    if (segLen < 2 || segEnd > len) return null;
    if (marker === 0xda) {
      reachedScan = true;
      break;
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (segLen < 8) return null;
      sof = {
        precision: b[segStart],
        h: (b[segStart + 1] << 8) | b[segStart + 2],
        w: (b[segStart + 3] << 8) | b[segStart + 4],
        comps: b[segStart + 5],
      };
      sofCount++;
    } else if (JPEG_REFUSED_SOF.has(marker)) {
      return null;  // lossless, differential or arithmetic coding
    } else if (marker === 0xe1 && !exifSeen && ascii(b, segStart, segStart + 6) === "Exif\0\0") {
      exifSeen = true;
      orientation = exifOrientation(b, segStart, segEnd);
    } else if (marker === 0xee && ascii(b, segStart, segStart + 5) === "Adobe") {
      adobe = true;
    }
    p = segEnd;
  }
  if (!reachedScan || sofCount !== 1 || !sof) return null;
  if (sof.precision !== 8 || sof.w === 0 || sof.h === 0) return null;
  if (!(sof.comps === 1 || sof.comps === 3 || (sof.comps === 4 && adobe))) return null;
  const swap = orientation >= 5;
  return {
    kind: "jpeg", pixelW: sof.w, pixelH: sof.h, orientation,
    displayW: swap ? sof.h : sof.w, displayH: swap ? sof.w : sof.h, channels: sof.comps,
  };
}

/** Header-only, bounds-checked. No decode. null = unreadable or an unsupported encoding. Size caps are applied by imageToPdf. */
export function readImageHeader(bytes: Uint8Array, kind: "png" | "jpeg"): ImageHeader | null {
  try {
    if (!(bytes instanceof Uint8Array)) return null;
    return kind === "png" ? readPngHeader(bytes) : readJpegHeader(bytes);
  } catch {
    return null;
  }
}

function startsWithAscii(b: Uint8Array, start: number, end: number, text: string): boolean {
  return end - start >= text.length && ascii(b, start, start + text.length) === text;
}

/**
 * Rebuild a JPEG keeping APP0 JFIF + APP14 Adobe and every coding segment,
 * dropping APP1-13, APP15, COM (EXIF/GPS/serials) and anything after EOI.
 * Returns a FRESH Uint8Array (byteOffset 0, buffer.byteLength === length),
 * because pdf-lib's JPEG parser ignores byteOffset (C25).
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const b = bytes;
  const len = b.byteLength;
  const copy = () => {
    const out = new Uint8Array(len);
    out.set(b);
    return out;
  };
  if (len < 4 || b[0] !== 0xff || b[1] !== 0xd8) return copy();
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let p = 2;
  let inScan = false;
  while (p < len) {
    if (inScan) {
      // Entropy-coded data runs until a marker that is not stuffing, fill or RSTn.
      let q = p;
      while (q + 1 < len) {
        if (b[q] === 0xff) {
          const next = b[q + 1];
          if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        q++;
      }
      if (q + 1 >= len) {
        parts.push(b.subarray(p, len));
        break;
      }
      parts.push(b.subarray(p, q));
      p = q;
      inScan = false;
      continue;
    }
    if (b[p] !== 0xff) return copy();
    let q = p;
    while (q < len && b[q] === 0xff) q++;
    if (q >= len) return copy();
    const marker = b[q];
    if (marker === 0xd9) {
      parts.push(Uint8Array.of(0xff, 0xd9));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(Uint8Array.of(0xff, marker));
      p = q + 1;
      continue;
    }
    if (q + 3 > len) return copy();
    const segLen = (b[q + 1] << 8) | b[q + 2];
    const segEnd = q + 1 + segLen;
    if (segLen < 2 || segEnd > len) return copy();
    const dataStart = q + 3;
    const metadata =
      (marker >= 0xe1 && marker <= 0xed) ||
      marker === 0xef ||
      marker === 0xfe ||
      (marker === 0xe0 && !startsWithAscii(b, dataStart, segEnd, "JFIF\0")) ||
      (marker === 0xee && !startsWithAscii(b, dataStart, segEnd, "Adobe"));
    if (!metadata) {
      parts.push(Uint8Array.of(0xff, marker));
      parts.push(b.subarray(q + 1, segEnd));
    }
    p = segEnd;
    if (marker === 0xda) inScan = true;
  }
  const total = parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function limitError(bytes: Uint8Array, h: ImageHeader): string | null {
  if (h.kind === "png") {
    if (h.pixelW > PNG_MAX_SIDE || h.pixelH > PNG_MAX_SIDE) {
      return "This PNG is larger than 8,000 pixels on a side. Export it as a JPEG under 14 MB.";
    }
    const raw = h.pixelW * h.pixelH * h.channels;
    if (raw > PNG_MAX_RAW_BYTES) return TOO_LARGE_FOR_PAGE;
    if (bytes.byteLength < raw / 1000) {
      return "This PNG is compressed too unusually to convert safely. Export it as a JPEG and upload it again.";
    }
    return null;
  }
  if (h.pixelW > JPEG_MAX_SIDE || h.pixelH > JPEG_MAX_SIDE || h.pixelW * h.pixelH > JPEG_MAX_PIXELS) {
    return "This photo is larger than 20 megapixels. Export a smaller JPEG and upload it again.";
  }
  return null;
}

/** §C.2 EXIF matrices: the unit image square → the drawn rect on the page, mirrored/rotated per orientation. */
function exifMatrix(orientation: number, x0: number, y0: number, dw: number, dh: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: return [-dw, 0, 0, dh, x0 + dw, y0];
    case 3: return [-dw, 0, 0, -dh, x0 + dw, y0 + dh];
    case 4: return [dw, 0, 0, -dh, x0, y0 + dh];
    case 5: return [0, -dh, -dw, 0, x0 + dw, y0 + dh];
    case 6: return [0, -dh, dw, 0, x0, y0 + dh];
    case 7: return [0, dh, dw, 0, x0, y0];
    case 8: return [0, dh, -dw, 0, x0 + dw, y0];
    default: return [dw, 0, 0, dh, x0, y0];
  }
}

/**
 * The converted PDF with every stream's bytes emptied, for inspectSourcePdf.
 * Its /XFA /ByteRange /Launch /RichMedia check is a raw byte scan, and a
 * photo's DCT or deflate data is near-random, so about 1 in 1,400 3 MB photos
 * would be refused as an "XFA form" on every retry (conversion is
 * deterministic). The dictionaries, page tree and boxes, everything the
 * structural checks and page geometry read, are the generated file's own.
 * null = the output didn't reload.
 */
export async function convertedStructureProbe(pdfBytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) doc.context.assign(ref, PDFRawStream.of(obj.dict, new Uint8Array(0)));
    }
    return await doc.save({ useObjectStreams: false });
  } catch {
    return null;
  }
}

export async function imageToPdf(
  bytes: Uint8Array, kind: "png" | "jpeg"
): Promise<{ ok: true; pdf: Uint8Array; header: ImageHeader } | { ok: false; error: string }> {
  try {
    if (!(bytes instanceof Uint8Array)) return { ok: false, error: UNREADABLE };
    if (bytes.byteLength > IMAGE_INPUT_MAX_BYTES) return { ok: false, error: INPUT_TOO_LARGE };
    const header = readImageHeader(bytes, kind);
    if (!header) return { ok: false, error: UNREADABLE };
    const limit = limitError(bytes, header);
    if (limit) return { ok: false, error: limit };

    const pdf = await PDFDocument.create({ updateMetadata: false });
    let image;
    try {
      image = kind === "jpeg" ? await pdf.embedJpg(stripJpegMetadata(bytes)) : await pdf.embedPng(bytes.slice());
    } catch {
      return { ok: false, error: UNREADABLE };
    }

    const layout = imagePageLayout(header.displayW, header.displayH);
    const page = pdf.addPage([layout.pageW, layout.pageH]);
    page.setRotation(degrees(0));
    // drawImage cannot mirror, so register the XObject and push the matrix ourselves.
    const key = page.node.newXObject("Image", image.ref);
    const [a, b, c, d, e, f] = exifMatrix(header.orientation, layout.drawX, layout.drawY, layout.drawW, layout.drawH);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, e, f), drawObject(key), popGraphicsState());

    const out = await pdf.save({ useObjectStreams: false });
    if (out.byteLength > SOURCE_MAX_BYTES) return { ok: false, error: TOO_LARGE_FOR_PAGE };
    return { ok: true, pdf: out, header };
  } catch {
    return { ok: false, error: UNREADABLE };
  }
}
