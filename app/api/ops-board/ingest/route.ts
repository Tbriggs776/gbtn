import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyIngest, type IngestApplyInput, type IngestApplyResult } from "@/lib/ops-board/persist";

// Push ingest for Floor Daddy ops mail. Not a schedule — nothing in vercel.json
// calls this. Chief of Staff / automation posts normalized messages later.
//
//   curl -sS -X POST "$NEXT_PUBLIC_SITE_URL/api/ops-board/ingest" \
//     -H "Authorization: Bearer $CRON_SECRET" \
//     -H "Content-Type: application/json" \
//     -d '{"dryRun":true,"items":[{"externalKey":"msg-1","from":"a@b.com","subject":"CG184422","bodyText":"Missed install.","receivedAt":"2026-09-23"}]}'
//
// dryRun classifies and reports duplicates without writing. A repeated
// externalKey does not create a second card.

export const dynamic = "force-dynamic";

const MAX_BATCH = 25;
const MAX_BODY = 100_000;

type ParsedItem = {
  externalKey: string;
  from: string;
  subject: string;
  bodyText: string;
  receivedAt: string | null;
};

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}

export async function POST(req: Request) {
  if (!(await authorizeCron(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = parseRequest(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const db = createAdminClient();
    const results: IngestApplyResult[] = [];
    for (const item of parsed.items) {
      const input: IngestApplyInput = {
        externalKey: item.externalKey,
        from: item.from,
        subject: item.subject,
        bodyText: item.bodyText,
        receivedAt: item.receivedAt,
        dryRun: parsed.dryRun,
        review: null,
      };
      results.push(await applyIngest(db, db, input));
    }
    return NextResponse.json({ ok: true, dryRun: parsed.dryRun, results });
  } catch {
    return NextResponse.json({ error: "ingest failed" }, { status: 500 });
  }
}

function parseRequest(body: unknown): { dryRun: boolean; items: ParsedItem[] } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object." };
  }
  const rec = body as Record<string, unknown>;
  if (rec.dryRun !== undefined && typeof rec.dryRun !== "boolean") {
    return { error: "dryRun must be a boolean." };
  }
  if (!Array.isArray(rec.items)) return { error: "items must be an array." };
  if (rec.items.length === 0) return { error: "items must include at least one email." };
  if (rec.items.length > MAX_BATCH) return { error: `items is capped at ${MAX_BATCH}.` };

  const items: ParsedItem[] = [];
  for (let i = 0; i < rec.items.length; i++) {
    const item = parseItem(rec.items[i], i);
    if (typeof item === "string") return { error: item };
    items.push(item);
  }
  return { dryRun: rec.dryRun === true, items };
}

function parseItem(raw: unknown, index: number): ParsedItem | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `items[${index}] must be an object.`;
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.externalKey !== "string" || !rec.externalKey.trim()) {
    return `items[${index}].externalKey is required.`;
  }
  if (rec.externalKey.trim().length > 500) return `items[${index}].externalKey is too long.`;

  const from = optionalString(rec.from, index, "from", 500);
  if (typeof from !== "object") return from;
  const subject = optionalString(rec.subject, index, "subject", 500);
  if (typeof subject !== "object") return subject;
  const bodyText = optionalString(rec.bodyText, index, "bodyText", MAX_BODY);
  if (typeof bodyText !== "object") return bodyText;

  let receivedAt: string | null = null;
  if (rec.receivedAt != null && rec.receivedAt !== "") {
    if (typeof rec.receivedAt !== "string") return `items[${index}].receivedAt must be a string.`;
    if (rec.receivedAt.trim().length > 80) return `items[${index}].receivedAt is too long.`;
    receivedAt = rec.receivedAt.trim();
  }

  return {
    externalKey: rec.externalKey.trim(),
    from: from.value,
    subject: subject.value,
    bodyText: bodyText.value,
    receivedAt,
  };
}

function optionalString(
  value: unknown,
  index: number,
  field: string,
  max: number
): { value: string } | string {
  if (value == null) return { value: "" };
  if (typeof value !== "string") return `items[${index}].${field} must be a string.`;
  if (value.length > max) return `items[${index}].${field} is too long.`;
  return { value };
}
