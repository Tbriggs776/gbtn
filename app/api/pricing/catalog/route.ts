import { NextResponse } from "next/server";
import { getSession, getAccessibleClients } from "@/lib/auth";
import catalog from "@/lib/pricing/catalog.json";

// The catalog contains internal cost data — gate it to Floor Daddy members /
// admins (not public).
const FLOOR_DADDY = "1c33f100-30eb-4337-b923-a48f84ba6e95";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const clients = await getAccessibleClients();
  const allowed = session.isAdmin || clients.some((c) => c.id === FLOOR_DADDY);
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  return NextResponse.json(catalog, {
    headers: { "Cache-Control": "private, max-age=3600" },
  });
}
