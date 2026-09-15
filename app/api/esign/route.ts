import { z } from "zod";
import { TOKEN_RE, type EsignErrorCode } from "@/lib/esign/types";
import { EsignError, esignJson, toResponse } from "@/lib/esign/errors";
import { assertSameOrigin, contextFromRequest } from "@/lib/esign/request-context";
import {
  declineRecipient,
  getOriginalUrl,
  getSealedUrl,
  getSourceUrl,
  loadSigningView,
  markViewed,
  sendOtp,
  submitRecipient,
  verifyOtp,
} from "@/lib/esign/engine";

/**
 * The signer's API: every action a token holder can take on /sign/[token].
 *
 * This is the only e-sign mutation surface reachable without a session (the
 * seal route next door only triggers idempotent, lease-guarded sealing).
 * Middleware matches /portal/* only, so nothing runs in front of it; the token
 * itself is the capability. Every call is authorized inside the engine by
 * TOKEN_RE plus a token_hash lookup before the service role reads anything.
 *
 *   POST only. A GET gets Next's default 405, so a link unfurler or mail
 *   scanner can never change state.
 *
 *   JSON content type required. That forces a CORS preflight for cross-site
 *   callers, which this route never grants; the Origin check backs it up.
 *
 *   Headers. esignJson/toResponse stamp no-store, no-referrer, noindex and
 *   nosniff on every response, success or error.
 *
 *   Sealing. Submit never seals (C11); the page calls /api/esign/seal.
 *
 *   Logging. Never the token, the body, or row data — only the action and an
 *   error class name.
 */
export const runtime = "nodejs"; // node:crypto, Buffer, pdf-lib probe
export const dynamic = "force-dynamic";
export const maxDuration = 60; // submit re-hashes the frozen render/original and the client-files original

// A signature PNG is at most 350 KB decoded (~470 KB base64) and is reused for
// every field, so the body does not grow with field count.
const MAX_BODY = 1_000_000;

const Token = z.string().regex(TOKEN_RE);
const Uuid = z.string().uuid();
const Signature = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("drawn"),
    png: z.string().startsWith("data:image/png;base64,").max(480_000),
    inkLength: z.number().finite().min(0).max(1_000_000),
  }),
  // Normalization and the 2-120 rule happen in the engine.
  z.object({ method: z.literal("typed"), text: z.string().min(1).max(200) }),
]);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), token: Token }),
  z.object({ action: z.literal("view"), token: Token }),
  z.object({ action: z.literal("source_url"), token: Token }),
  z.object({ action: z.literal("original_url"), token: Token }),
  z.object({ action: z.literal("send_otp"), token: Token }),
  z.object({ action: z.literal("verify_otp"), token: Token, code: z.string().regex(/^\d{6}$/) }),
  z.object({
    action: z.literal("submit"),
    token: Token,
    consent: z.literal(true),
    printedName: z.string().trim().min(2).max(120),
    timeZone: z.string().trim().min(1).max(64),
    signature: Signature,
    appliedFieldIds: z.array(Uuid).min(1).max(100),
    otpSession: z.string().regex(TOKEN_RE).optional(),
  }),
  z.object({
    action: z.literal("decline"),
    token: Token,
    reason: z.string().trim().max(1000).optional(),
    otpSession: z.string().regex(TOKEN_RE).optional(),
  }),
  z.object({ action: z.literal("sealed_url"), token: Token }),
]);

const UNREADABLE = "That request couldn't be read. Refresh the page and try again.";

function reject(code: EsignErrorCode, message: string) {
  return toResponse(new EsignError(code, message));
}

// Reads the body with a hard byte cap, so a missing or lying content-length
// can't make us buffer more than MAX_BODY. Returns null when over the cap.
async function readBoundedText(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(req: Request) {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return reject("unsupported_media_type", "This endpoint only accepts JSON.");
  }

  if (!assertSameOrigin(req)) {
    return reject("forbidden_origin", "This request isn't allowed from another site.");
  }

  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    return reject("payload_too_large", "That request is too large.");
  }

  let text: string | null;
  try {
    text = await readBoundedText(req, MAX_BODY);
  } catch {
    return reject("bad_request", UNREADABLE);
  }
  if (text === null || text.length > MAX_BODY) {
    return reject("payload_too_large", "That request is too large.");
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return reject("bad_request", UNREADABLE);
  }
  // Never echo zod issues: they would include the token.
  const parsed = Body.safeParse(json);
  if (!parsed.success) return reject("bad_request", UNREADABLE);

  const body = parsed.data;
  const ctx = contextFromRequest(req);

  try {
    switch (body.action) {
      case "get":
        // Pure read. An unknown token is a 200 with { state: "invalid" }.
        return esignJson({ ok: true, data: await loadSigningView(body.token) }, 200);
      case "view":
        return esignJson({ ok: true, data: await markViewed(body.token, ctx) }, 200);
      case "source_url":
        return esignJson({ ok: true, data: await getSourceUrl(body.token, ctx) }, 200);
      case "original_url":
        return esignJson({ ok: true, data: await getOriginalUrl(body.token, ctx) }, 200);
      case "send_otp":
        return esignJson({ ok: true, data: await sendOtp(body.token, ctx) }, 200);
      case "verify_otp":
        return esignJson({ ok: true, data: await verifyOtp(body.token, body.code, ctx) }, 200);
      case "submit":
        return esignJson(
          {
            ok: true,
            data: await submitRecipient(
              body.token,
              {
                printedName: body.printedName,
                timeZone: body.timeZone,
                signature: body.signature,
                appliedFieldIds: body.appliedFieldIds,
                otpSession: body.otpSession ?? null,
              },
              ctx
            ),
          },
          200
        );
      case "decline":
        return esignJson(
          {
            ok: true,
            data: await declineRecipient(
              body.token,
              { reason: body.reason ? body.reason : null, otpSession: body.otpSession ?? null },
              ctx
            ),
          },
          200
        );
      case "sealed_url":
        return esignJson({ ok: true, data: await getSealedUrl(body.token, ctx) }, 200);
    }
  } catch (e) {
    if (!(e instanceof EsignError)) {
      console.error("[esign]", body.action, e instanceof Error ? e.name : "error");
    }
    return toResponse(e);
  }
  return reject("bad_request", UNREADABLE);
}
