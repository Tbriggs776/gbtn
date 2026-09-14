import "server-only";

// Signer network context for the token route only. Staff actions never read
// request headers: staff and system events store no IP or user agent.

export type EsignRequestContext = { ip: string | null; userAgent: string | null };

/**
 * IP is the first x-forwarded-for hop, then x-real-ip. Vercel sets XFF; whether
 * it strips a client-supplied value is unverified, so the certificate labels it
 * "as reported by the hosting edge".
 */
export function contextFromRequest(req: Request): EsignRequestContext {
  const h = req.headers;
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = (forwarded || h.get("x-real-ip")?.trim() || "").slice(0, 64);
  const userAgent = (h.get("user-agent") ?? "").trim().slice(0, 512);
  return { ip: ip || null, userAgent: userAgent || null };
}

/** When an Origin header is present its host must match this deployment's host. A missing Origin is allowed. */
export function assertSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}
