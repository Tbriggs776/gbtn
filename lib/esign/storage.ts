import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Bucket IO for the e-sign engine. Callers pass the service-role client, and
// only after a token-hash lookup or assertStaff + sessionCan. There is no
// long-lived URL anywhere: every mint is 60 seconds. Errors never carry a
// storage path (paths identify clients), only a generic message.
//
// esign bucket layout (v2):
//   envelopes/{envelope}/original.bin                                 frozen original, octet-stream
//   envelopes/{envelope}/render.pdf                                   frozen render (what signers see)
//   envelopes/{envelope}/recipients/{recipient}/attempts/{a}/signature.png
//   envelopes/{envelope}/attempts/{a}/sealed.pdf
// Attempt-scoped paths mean a losing concurrent writer can never overwrite the
// winner's object. v2 writes nothing into client-files.

export const ESIGN_BUCKET = "esign",
  CLIENT_FILES_BUCKET = "client-files",
  SIGNED_URL_TTL_SECONDS = 60;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path segments are always uuids; anything else would let a caller bug escape the envelope prefix. */
function segment(id: string): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("E-sign storage path id is malformed.");
  return id.toLowerCase();
}

export function envelopeOriginalPath(envelopeId: string): string {
  return `envelopes/${segment(envelopeId)}/original.bin`;
}

export function envelopeRenderPath(envelopeId: string): string {
  return `envelopes/${segment(envelopeId)}/render.pdf`;
}

export function recipientSignaturePath(envelopeId: string, recipientId: string, attemptId: string): string {
  return `envelopes/${segment(envelopeId)}/recipients/${segment(recipientId)}/attempts/${segment(attemptId)}/signature.png`;
}

export function envelopeSealedPath(envelopeId: string, attemptId: string): string {
  return `envelopes/${segment(envelopeId)}/attempts/${segment(attemptId)}/sealed.pdf`;
}

/** The service role must never download a path a client member pointed outside their own prefix. */
export function isClientScopedPath(path: string, clientId: string): boolean {
  if (typeof path !== "string" || typeof clientId !== "string" || !clientId) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.length < 2 || segments[0] !== clientId) return false;
  return !segments.some((s) => s === ".." || s === ".");
}

/** Printable ASCII, header-safe, max 120 chars, trailing extension-looking suffix removed. */
function downloadBase(title: string, stripExtension: RegExp): string {
  return (title ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|%#;]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(stripExtension, "")
    .slice(0, 120)
    .replace(/^[\s.-]+|[\s.-]+$/g, "");
}

/** Filesystem- and header-safe download name: printable ASCII, max 120 chars, plus "-signed.pdf". */
export function sealedDownloadName(title: string): string {
  return `${downloadBase(title, /\.pdf$/i) || "document"}-signed.pdf`;
}

/**
 * Download/attachment name for a certificate-mode original: the TITLE's safe
 * base (sealedDownloadName rules) plus "." + the extension from the byte sniff
 * (S6). The uploaded file_name never decides the extension.
 */
export function originalDownloadName(title: string, extension: string): string {
  const ext = String(extension ?? "").replace(/^\./, "").toLowerCase();
  const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
  const base = downloadBase(title, /\.(pdf|png|jpe?g|docx|xlsx|pptx|txt|csv)$/i);
  return `${base || "document"}.${safeExt}`;
}

export async function downloadObject(db: SupabaseClient, bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) throw new Error("E-sign storage download failed.");
  return new Uint8Array(await data.arrayBuffer());
}

/** Storage reports a missing object as status 404 or statusCode "404" (sometimes on an HTTP 400). */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { status?: unknown; statusCode?: unknown };
  return e.status === 404 || String(e.statusCode ?? "") === "404";
}

/**
 * Like downloadObject, but resolves null ONLY when the object is confirmed
 * missing. Every other failure (network, 5xx, auth) still throws, so a caller
 * can tell "the file is gone" (drift) from "storage is having a moment" (retry).
 */
export async function downloadObjectOrMissing(
  db: SupabaseClient, bucket: string, path: string
): Promise<Uint8Array | null> {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error) {
    if (isNotFound(error)) return null;
    throw new Error("E-sign storage download failed.");
  }
  if (!data) throw new Error("E-sign storage download failed.");
  return new Uint8Array(await data.arrayBuffer());
}

/** Always upsert:false: an existing object is never replaced. */
export async function uploadObject(
  db: SupabaseClient, bucket: string, path: string, bytes: Uint8Array,
  contentType: "application/pdf" | "image/png" | "application/octet-stream"
): Promise<void> {
  const { error } = await db.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
  if (error) throw new Error("E-sign storage upload failed.");
}

export async function removeObjectsQuietly(db: SupabaseClient, bucket: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    const { error } = await db.storage.from(bucket).remove(paths);
    if (error) console.error("[esign] storage cleanup failed", bucket, paths.length);
  } catch {
    console.error("[esign] storage cleanup failed", bucket, paths.length);
  }
}

export async function shortSignedUrl(
  db: SupabaseClient, bucket: string, path: string, opts?: { download?: string }
): Promise<string> {
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS, opts?.download ? { download: opts.download } : undefined);
  if (error || !data?.signedUrl) throw new Error("E-sign signed URL failed.");
  return data.signedUrl;
}
