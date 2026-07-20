import { NextResponse } from "next/server";
import { z } from "zod";
import { assertCapability } from "@/lib/auth";
import { listOrderLines } from "@/lib/ops/service";
import {
  asOfFrom,
  DATE_BASES,
  parseDateParam,
  type DateBasis,
  type DateWindow,
  type Grain,
} from "@/lib/ops/pipeline";
import { buildDrillRows, DRILL_KINDS, LINE_SCOPES, type DrillSpec } from "@/lib/ops/drill";

const GRAINS = ["day", "week", "month"] as const;

/**
 * The CGs behind one number on the Orders Pipeline — a tile, a period-table
 * cell, or a chart point. The slice is rebuilt server-side by lib/ops/drill,
 * which shares its filter primitives with the bucketing code, so the list
 * always ties to the aggregate that was clicked.
 *
 * listOrderLines uses the service role (bypasses RLS), so membership is
 * checked here, exactly as /api/ops/lines does.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const clientId = p.get("client") ?? "";
  const kind = p.get("kind") ?? "";
  const scope = p.get("scope") ?? "all";
  const grain = p.get("grain") ?? "";
  const key = p.get("key") ?? "";

  if (!z.string().uuid().safeParse(clientId).success) {
    return NextResponse.json({ error: "Bad client." }, { status: 400 });
  }
  if (!(DRILL_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "Bad kind." }, { status: 400 });
  }
  if (!(LINE_SCOPES as readonly string[]).includes(scope)) {
    return NextResponse.json({ error: "Bad scope." }, { status: 400 });
  }
  const needsPeriod = kind.endsWith("-period");
  if (needsPeriod) {
    if (!(GRAINS as readonly string[]).includes(grain)) {
      return NextResponse.json({ error: "Bad grain." }, { status: 400 });
    }
    // Bucket keys are always full dates (month buckets end in -01).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      return NextResponse.json({ error: "Bad key." }, { status: 400 });
    }
  }

  try {
    await assertCapability(clientId, "ops");
  } catch {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  try {
    const lines = await listOrderLines(clientId);
    // asOf comes from the unfiltered set, matching the page — the window must
    // not move what counts as scheduled ahead.
    const asOf = asOfFrom(lines);
    const window: DateWindow = {
      from: parseDateParam(p.get("from")),
      to: parseDateParam(p.get("to")),
      basis: (DATE_BASES as readonly string[]).includes(p.get("basis") ?? "")
        ? (p.get("basis") as DateBasis)
        : "either",
    };
    const spec = (
      needsPeriod
        ? { kind, grain: grain as Grain, key, scope }
        : { kind, scope }
    ) as DrillSpec;
    return NextResponse.json({ rows: buildDrillRows(lines, spec, asOf, window), asOf });
  } catch (e) {
    // Detail stays server-side; DB error text names tables and drivers.
    console.error("ops/drilldown:", e);
    return NextResponse.json({ error: "Could not build the drill-down." }, { status: 500 });
  }
}
