import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { EsignSnapshot } from "./types";

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
 * (jsonb reorders keys and may re-render floats). So the document hash is
 * reproducible from the stored document_snapshot. Throws on anything else.
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

/** Hash version 1: everything the signer was shown, bound to the exact source bytes. */
export function computeDocumentHash(i: {
  snapshot: EsignSnapshot; consentText: string; checkboxText: string; sourceSha256: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      snapshot: i.snapshot,
      consent_text: i.consentText,
      checkbox_text: i.checkboxText,
      source_sha256: i.sourceSha256,
    })
  );
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), "utf8"), Buffer.from(b.toLowerCase(), "utf8"));
}
