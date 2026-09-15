import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { EsignSnapshotV2, SignatureMethod } from "./types";

export function sha256Hex(input: string | Uint8Array): string {
  const h = createHash("sha256");
  if (typeof input === "string") h.update(input, "utf8");
  else h.update(input);
  return h.digest("hex");
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit (recursively),
 * array order kept, no whitespace. Only strings, booleans, null and safe
 * integers are allowed, because those survive a jsonb round-trip unchanged
 * (jsonb reorders keys and may re-render floats). So every hash below is
 * reproducible from stored rows. Throws on anything else.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError("canonicalJson: only safe integers are allowed.");
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) parts.push(canonicalJson(value[i]));
        return `[${parts.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJson: only plain objects are allowed.");
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not allowed.`);
  }
}

// Postgres/PostgREST renders timestamptz with up to microseconds and an offset
// ("2026-09-14T17:03:22.123456+00:00", sometimes "+00" or a space separator).
// Engines differ on parsing more than three fractional digits, so those strings
// are rebuilt with the fraction TRUNCATED to milliseconds before parsing. Both
// sides of every hash call this, so the result only has to be deterministic.
const PG_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Every timestamp inside a hash goes through this: DB strings and Dates both → ms-precision ISO Z. Throws on an invalid date. */
export function isoMs(v: string | Date): string {
  let d: Date;
  if (v instanceof Date) {
    d = new Date(v.getTime());
  } else if (typeof v === "string") {
    const m = PG_TIMESTAMP_RE.exec(v.trim());
    if (m) {
      const [, date, time, fraction = "", zone] = m;
      const seconds = time.length === 5 ? `${time}:00` : time;
      const ms = `${fraction}000`.slice(0, 3);
      let offset = "Z";
      if (zone && zone.toUpperCase() !== "Z") {
        const digits = zone.slice(1).replace(":", "");
        offset = `${zone[0]}${digits.slice(0, 2)}:${(digits.slice(2) || "00").padEnd(2, "0")}`;
      }
      d = new Date(`${date}T${seconds}.${ms}${offset}`);
    } else {
      d = new Date(v);
    }
  } else {
    throw new TypeError("isoMs: expected a string or Date.");
  }
  if (Number.isNaN(d.getTime())) throw new TypeError("isoMs: invalid date.");
  return d.toISOString();
}

/** v2: sha256(canonicalJson({ v: 2, snapshot })). Consent is per recipient, so it is NOT here. */
export function computeDocumentHashV2(snapshot: EsignSnapshotV2): string {
  return sha256Hex(canonicalJson({ v: 2, snapshot }));
}

export function computeRecipientHash(i: {
  documentHash: string; recipientId: string; consentText: string; checkboxText: string; requireSmsOtp: boolean;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 2,
      document_hash: i.documentHash,
      recipient_id: i.recipientId,
      consent_text: i.consentText,
      checkbox_text: i.checkboxText,
      require_sms_otp: i.requireSmsOtp,
    })
  );
}

export type ReceiptInput = {
  envelopeId: string; documentHash: string; recipientId: string; recipientHash: string; routingOrder: number;
  chainIndex: number; prevReceiptSha256: string | null; method: SignatureMethod;
  signatureImageSha256: string | null; typedText: string | null; typedFont: string | null;
  printedName: string; dateText: string; timeZone: string;
  /** isoMs; written to Postgres as exactly this string. */
  signedAt: string;
  /** isoMs of the DB value. */
  otpVerifiedAt: string | null;
  /** Already truncated to 64, as stored. */
  ip: string | null;
  /** Already truncated to 512, as stored. */
  userAgent: string | null;
  /** Hashed sorted ascending. */
  appliedFieldIds: string[];
};

/**
 * One signature's receipt, chained to the previous one by chain_index. Timestamps
 * pass through isoMs (idempotent for isoMs output), so a DB round trip of the
 * same instant re-derives the same hash.
 */
export function computeReceiptHash(i: ReceiptInput): string {
  return sha256Hex(
    canonicalJson({
      v: 2,
      envelope_id: i.envelopeId,
      document_hash: i.documentHash,
      recipient_id: i.recipientId,
      recipient_hash: i.recipientHash,
      routing_order: i.routingOrder,
      chain_index: i.chainIndex,
      prev_receipt_sha256: i.prevReceiptSha256,
      method: i.method,
      signature_image_sha256: i.signatureImageSha256,
      typed_text: i.typedText,
      typed_font: i.typedFont,
      printed_name: i.printedName,
      date_text: i.dateText,
      time_zone: i.timeZone,
      signed_at: isoMs(i.signedAt),
      otp_verified_at: i.otpVerifiedAt === null ? null : isoMs(i.otpVerifiedAt),
      ip: i.ip,
      user_agent: i.userAgent,
      applied_field_ids: [...i.appliedFieldIds].sort(),
    })
  );
}

/** sha256(canonicalJson({ v: 2, document_hash, receipts })), receipts in chain_index order. */
export function computeEnvelopeHash(i: { documentHash: string; receipts: string[] }): string {
  return sha256Hex(canonicalJson({ v: 2, document_hash: i.documentHash, receipts: [...i.receipts] }));
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), "utf8"), Buffer.from(b.toLowerCase(), "utf8"));
}
