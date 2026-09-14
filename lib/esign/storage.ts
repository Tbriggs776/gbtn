import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Bucket IO for the e-sign engine. Callers pass the service-role client, and
// only after a token-hash lookup or assertStaff + sessionCan. There is no
// long-lived URL anywhere: every mint is 60 seconds. Errors never carry a
// storage path (paths identify clients), only a generic message.

export const ESIGN_BUCKET = "esign",
  CLIENT_FILES_BUCKET = "client-files",
  SIGNED_URL_TTL_SECONDS = 60;

export function frozenSourcePath(requestId: string): string {
  return `requests/${requestId}/source.pdf`;
}

/** Attempt-scoped, so a losing concurrent submit can never overwrite the winner's artifacts. */
export function attemptPaths(requestId: string, attemptId: string): { signature: string; sealed: string } {
  const base = `requests/${requestId}/attempts/${attemptId}`;
  return { signature: `${base}/signature.png`, sealed: `${base}/sealed.pdf` };
}

/** Convenience copy only. No code path serves it; Signed copy downloads read the esign bucket. */
export function sealedClientPath(clientId: string, requestId: string, attemptId: string): string {
  return `${clientId}/esign/${requestId}/${attemptId}-signed.pdf`;
}

/** The service role must never download a path a client member pointed outside their own prefix. */
export function isClientScopedPath(path: string, clientId: string): boolean {
  if (typeof path !== "string" || typeof clientId !== "string" || !clientId) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.length < 2 || segments[0] !== clientId) return false;
  return !segments.some((s) => s === ".." || s === ".");
}

/** Filesystem- and header-safe download name: printable ASCII, max 120 chars, plus "-signed.pdf". */
export function sealedDownloadName(title: string): string {
  const base = (title ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/:*?"<>|%#;]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.pdf$/i, "")
    .slice(0, 120)
    .replace(/^[\s.-]+|[\s.-]+$/g, "");
  return `${base || "document"}-signed.pdf`;
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

export async function uploadObject(
  db: SupabaseClient, bucket: string, path: string, bytes: Uint8Array,
  contentType: "application/pdf" | "image/png"
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
