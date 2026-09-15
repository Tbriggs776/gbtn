import "server-only";
import { sha256Hex } from "./hash";

// Cheap structural checks on the drawn signature before it reaches pdf-lib.
// probeSignaturePng() fully parses it at submit, and embedPng() again at seal.
// The pad trims its export to the ink (C21), so a real signature can be a
// small file; blankness is gated by inkLength ≥ 40 in the engine, and the byte
// floor here only rejects degenerate images.

export const SIGNATURE_MAX_BYTES = 350_000;
const SIGNATURE_MIN_BYTES = 256;
const PREFIX = "data:image/png;base64,";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function parseSignatureDataUrl(dataUrl: string):
  | { ok: true; bytes: Uint8Array; width: number; height: number; sha256: string }
  | { ok: false; error: string } {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PREFIX)) {
    return { ok: false, error: "The signature must be a PNG image." };
  }
  const b64 = dataUrl.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    return { ok: false, error: "The signature image is malformed." };
  }
  const buf = Buffer.from(b64, "base64");
  // Strict decode: Node silently skips junk, so re-encode and compare.
  if (buf.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
    return { ok: false, error: "The signature image is malformed." };
  }
  if (buf.byteLength < SIGNATURE_MIN_BYTES) {
    return { ok: false, error: "The signature looks blank. Please sign again." };
  }
  if (buf.byteLength > SIGNATURE_MAX_BYTES) {
    return { ok: false, error: "The signature image is too large." };
  }
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return { ok: false, error: "The signature must be a PNG image." };
  }
  if (buf.toString("latin1", 12, 16) !== "IHDR") {
    return { ok: false, error: "The signature image is malformed." };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 100 || width > 2400 || height < 40 || height > 1200) {
    return { ok: false, error: "The signature image has unexpected dimensions." };
  }
  const bytes = Uint8Array.from(buf);
  return { ok: true, bytes, width, height, sha256: sha256Hex(bytes) };
}
