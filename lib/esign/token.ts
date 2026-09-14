import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { appBaseUrl } from "@/lib/crm/comms";
import { TOKEN_RE } from "./types";

// Signing tokens are 256 bits of CSPRNG output, base64url (43 chars). Only the
// sha256 hex is stored, so a DB read can never mint a working link; "resend"
// always means void plus a new token. Lookup is an equality match on
// token_hash, so there is no app-side comparison to time.

export function generateSigningToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSigningToken(token) };
}

export function hashSigningToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Checked before any DB access, so malformed input costs nothing. */
export function isWellFormedToken(t: unknown): t is string {
  return typeof t === "string" && TOKEN_RE.test(t);
}

export function signUrlFor(token: string): string {
  return `${appBaseUrl()}/sign/${token}`;
}
