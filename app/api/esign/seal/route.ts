import { z } from "zod";
import { TOKEN_RE, type EsignErrorCode, type EsignSealBody } from "@/lib/esign/types";
import { EsignError, esignJson, toResponse } from "@/lib/esign/errors";
import { assertSameOrigin } from "@/lib/esign/request-context";
import { sealFromSigner } from "@/lib/esign/engine";

/**
 * Seal trigger for the signing page (C11).
 *
 * The signing page POSTs here right after a submit returns `completing`, and
 * again from a "Check status" click. Sealing downloads the frozen render,
 * every signature image and (certificate mode) the original, rebuilds the
 * receipt chain and writes the sealed PDF, which can take longer than a
 * signer's 60-second submit, hence its own 300-second function.
 *
 * Authorization is the token: sealFromSigner seals only for a LIVE token of a
 * SIGNED recipient of a `completing` envelope, and only while it holds the
 * exclusive SQL seal lease (esign_claim_seal, with backoff after failures), so
 * repeated calls can't stack heavy work or flood the event table (S8/C12).
 * Anything else just returns the current SigningView. No document bytes are
 * ever proxied here; downloads stay 60-second signed URLs.
 */
export const runtime = "nodejs"; // pdf-lib, node:crypto, Buffer
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BODY = 1_000;

const Body = z.object({ action: z.literal("seal"), token: z.string().regex(TOKEN_RE) });

const UNREADABLE = "That request couldn't be read. Refresh the page and try again.";

function reject(code: EsignErrorCode, message: string) {
  return toResponse(new EsignError(code, message));
}

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
  const body: EsignSealBody = parsed.data;

  try {
    return esignJson({ ok: true, data: await sealFromSigner(body.token) }, 200);
  } catch (e) {
    if (!(e instanceof EsignError)) console.error("[esign] seal", e instanceof Error ? e.name : "error");
    return toResponse(e);
  }
}
