import { NextResponse } from "next/server";
import { z } from "zod";
import { assertCapability } from "@/lib/auth";
import { listLinesForCG } from "@/lib/ops/service";

/**
 * Line detail for one CG, for the Install Pipeline's row expansion.
 *
 * The board ships CG summaries only (~240KB); shipping every line of a full
 * export would be ~6MB. This serves the ~20 lines of the row a user opened.
 *
 * listLinesForCG uses the service role, which bypasses RLS — so membership is
 * checked here, exactly as the server actions do.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get("client") ?? "";
  const cg = searchParams.get("cg") ?? "";

  if (!z.string().uuid().safeParse(clientId).success) {
    return NextResponse.json({ error: "Bad client." }, { status: 400 });
  }
  // CG ids are RFMS invoice numbers: letters and digits, nothing else.
  if (!/^[A-Za-z0-9-]{1,32}$/.test(cg)) {
    return NextResponse.json({ error: "Bad CG." }, { status: 400 });
  }

  try {
    await assertCapability(clientId, "ops");
  } catch {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  try {
    const lines = await listLinesForCG(clientId, cg);
    return NextResponse.json({ lines });
  } catch (e) {
    // Detail stays server-side; DB error text names tables and drivers.
    console.error("ops/lines:", e);
    return NextResponse.json({ error: "Could not load lines." }, { status: 500 });
  }
}
