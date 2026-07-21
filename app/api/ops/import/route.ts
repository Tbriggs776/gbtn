import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { assertCapability } from "@/lib/auth";
import { parseOrdersExport } from "@/lib/ops/csv-import";
import { loadOrders } from "@/lib/ops/service";

/**
 * Import an RFMS Orders export.
 *
 * This is a route handler rather than a server action for two reasons, both
 * learned the hard way:
 *
 *   Size. Vercel rejects any request body over ~4.5 MB at the edge with a 413
 *   before the function runs — a platform limit that next.config's
 *   serverActions.bodySizeLimit cannot raise (that setting only governs Next's
 *   own check, so raising it fixes local dev and nothing else). The real export
 *   is 11.5 MB. The client gzips it to ~1.8 MB before sending; see the uploader.
 *
 *   Failure shape. When the 413 did happen, the plain-text error came back where
 *   a server-action result was expected, and the exception blanked the whole page
 *   with "a client-side exception has occurred" instead of showing the user an
 *   error. A fetch() to a route handler returns a status the client can read and
 *   render, so a failed import stays a failed import.
 *
 * The export is a full snapshot, so this REPLACES the client's order lines
 * rather than merging (see loadOrders).
 */
export const runtime = "nodejs";
export const maxDuration = 300;

// Refuse anything that couldn't fit anyway, with a message instead of a 413.
const MAX_BODY = 4_000_000;

export async function POST(req: Request) {
  const clientId = new URL(req.url).searchParams.get("client") ?? "";
  if (!z.string().uuid().safeParse(clientId).success) {
    return NextResponse.json({ error: "Pick a client first." }, { status: 400 });
  }

  try {
    await assertCapability(clientId, "ops");
  } catch {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  let buf: Buffer;
  try {
    const raw = Buffer.from(await req.arrayBuffer());
    if (raw.byteLength === 0) {
      return NextResponse.json({ error: "That file was empty." }, { status: 400 });
    }
    if (raw.byteLength > MAX_BODY) {
      return NextResponse.json(
        { error: "That file is too large to upload even compressed." },
        { status: 413 }
      );
    }
    // The uploader gzips whatever it can; xlsx is already compressed so it
    // arrives as-is. The header says which.
    buf = req.headers.get("x-gbtn-encoding") === "gzip" ? gunzipSync(raw) : raw;
  } catch {
    return NextResponse.json({ error: "That upload could not be read." }, { status: 400 });
  }

  try {
    const parsed = parseOrdersExport(buf);
    const written = await loadOrders(clientId, parsed);

    revalidatePath("/portal/ops-reports/install-pipeline");
    revalidatePath("/portal/ops-reports/orders-pipeline");
    revalidatePath("/portal/ops-reports/speed-to-install");
    revalidatePath("/portal/ops-reports/status-hygiene");

    return NextResponse.json({
      ok: true,
      message: `Imported ${written.toLocaleString()} lines across ${parsed.cgCount.toLocaleString()} CGs (ordered ${parsed.minOrderDate} → ${parsed.maxOrderDate}).`,
      warnings: parsed.warnings,
    });
  } catch (e) {
    // Parse errors name the offending column and are worth showing; anything
    // else stays server-side.
    console.error("ops/import:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "That file could not be read." },
      { status: 400 }
    );
  }
}
