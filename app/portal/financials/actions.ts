"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession, requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { parseWorkbook } from "@/lib/financials/parse";
import { parseMrp } from "@/lib/financials/mrp";
import {
  guessCategory,
  normalizeLabel,
  type StatementType,
} from "@/lib/financials/categories";

const BUCKET = "client-files";

const parseSchema = z.object({
  clientId: z.string().uuid(),
  statementType: z.enum(["pl", "bs"]),
  periodLabel: z.string().min(1).max(60),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  storagePath: z.string().min(3),
  fileName: z.string().min(1).max(255),
});

export type ParsedRowOut = {
  rawLabel: string;
  values: (number | null)[];
  suggestedCategory: string;
};

export type ParseUploadResult = {
  uploadId: string;
  columns: { index: number; header: string }[];
  suggestedColumn: number;
  rows: ParsedRowOut[];
  error?: string;
};

export async function parseUploadAction(
  input: z.infer<typeof parseSchema>
): Promise<ParseUploadResult> {
  await requireSession();
  const parsed = parseSchema.safeParse(input);
  if (!parsed.success) {
    return { uploadId: "", columns: [], suggestedColumn: 0, rows: [], error: "Invalid input." };
  }
  const d = parsed.data;
  if (!d.storagePath.startsWith(`${d.clientId}/`)) {
    return { uploadId: "", columns: [], suggestedColumn: 0, rows: [], error: "Path mismatch." };
  }

  const supabase = await createClient();

  // Record the upload (draft).
  const { data: upload, error: upErr } = await supabase
    .from("financial_uploads")
    .insert({
      client_id: d.clientId,
      statement_type: d.statementType,
      period_label: d.periodLabel,
      period_start: d.periodStart || null,
      period_end: d.periodEnd || null,
      source_path: d.storagePath,
      file_name: d.fileName,
      status: "draft",
    })
    .select("id")
    .single();
  if (upErr || !upload) {
    return { uploadId: "", columns: [], suggestedColumn: 0, rows: [], error: upErr?.message ?? "Could not record upload." };
  }

  // Download + parse.
  const { data: blob, error: dlErr } = await supabase.storage
    .from(BUCKET)
    .download(d.storagePath);
  if (dlErr || !blob) {
    return { uploadId: upload.id, columns: [], suggestedColumn: 0, rows: [], error: "Could not read the file." };
  }

  let result;
  try {
    const buffer = Buffer.from(await blob.arrayBuffer());
    result = parseWorkbook(buffer);
  } catch {
    return { uploadId: upload.id, columns: [], suggestedColumn: 0, rows: [], error: "Could not parse the spreadsheet. Make sure it's a valid .xlsx or .csv." };
  }

  if (result.rows.length === 0) {
    return { uploadId: upload.id, columns: [], suggestedColumn: 0, rows: [], error: "No data rows found in the file." };
  }

  // Saved mappings take priority over heuristics.
  const { data: mappings } = await supabase
    .from("category_mappings")
    .select("raw_label_norm, category")
    .eq("client_id", d.clientId)
    .eq("statement_type", d.statementType);
  const saved = new Map((mappings ?? []).map((m) => [m.raw_label_norm, m.category]));

  const rows: ParsedRowOut[] = result.rows.map((r) => ({
    rawLabel: r.rawLabel,
    values: r.values,
    suggestedCategory:
      saved.get(normalizeLabel(r.rawLabel)) ??
      guessCategory(d.statementType as StatementType, r.rawLabel),
  }));

  return {
    uploadId: upload.id,
    columns: result.columns.map((c) => ({ index: c.index, header: c.header })),
    suggestedColumn: result.suggestedColumn,
    rows,
  };
}

const confirmSchema = z.object({
  uploadId: z.string().uuid(),
  items: z
    .array(
      z.object({
        rawLabel: z.string().min(1),
        category: z.string().min(1),
        amount: z.number(),
      })
    )
    .min(1),
});

export async function confirmUploadAction(
  input: z.infer<typeof confirmSchema>
): Promise<{ ok?: boolean; error?: string }> {
  await requireSession();
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid mapping." };
  const { uploadId, items } = parsed.data;

  const supabase = await createClient();
  const { data: upload, error: uErr } = await supabase
    .from("financial_uploads")
    .select("id, client_id, statement_type")
    .eq("id", uploadId)
    .single();
  if (uErr || !upload) return { error: "Upload not found." };

  // Replace any prior line items for this upload.
  await supabase.from("financial_line_items").delete().eq("upload_id", uploadId);

  const lineItems = items
    .filter((i) => i.category !== "exclude")
    .map((i, idx) => ({
      upload_id: uploadId,
      client_id: upload.client_id,
      statement_type: upload.statement_type,
      raw_label: i.rawLabel,
      category: i.category,
      amount: i.amount,
      sort_order: idx,
    }));

  if (lineItems.length > 0) {
    const { error: insErr } = await supabase
      .from("financial_line_items")
      .insert(lineItems);
    if (insErr) return { error: insErr.message };
  }

  // Remember every mapping (including excludes, so subtotals stay excluded).
  const maps = items.map((i) => ({
    client_id: upload.client_id,
    statement_type: upload.statement_type,
    raw_label_norm: normalizeLabel(i.rawLabel),
    category: i.category,
  }));
  // Dedupe by normalized label (last wins).
  const dedup = new Map(maps.map((m) => [m.raw_label_norm, m]));
  await supabase
    .from("category_mappings")
    .upsert([...dedup.values()], { onConflict: "client_id,statement_type,raw_label_norm" });

  await supabase
    .from("financial_uploads")
    .update({ status: "confirmed" })
    .eq("id", uploadId);

  revalidatePath("/portal/financials");
  revalidatePath("/portal");
  return { ok: true };
}

// Admin-only: parse an uploaded MRP workbook (DATA-PL / DATA-BS tabs) and
// reload the active client's financials in one pass. Replaces existing data.
export type MrpState = { ok?: boolean; error?: string; message?: string };

export async function loadMrpAction(
  _prev: MrpState,
  formData: FormData
): Promise<MrpState> {
  const session = await requireAdmin();
  const clientId = String(formData.get("clientId") ?? "");
  const year = Number(formData.get("year") ?? 0);
  const file = formData.get("file");

  if (!z.string().uuid().safeParse(clientId).success)
    return { error: "Pick a client first." };
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    return { error: "Enter a valid year." };
  if (!(file instanceof File) || file.size === 0)
    return { error: "Choose an MRP workbook to upload." };

  let result;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    result = parseMrp(buffer, year);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not parse the workbook." };
  }

  const supabase = await createClient();
  // Clean reload: the MRP is the source of truth for the dashboard.
  await supabase.from("financial_uploads").delete().eq("client_id", clientId);

  let statements = 0;
  for (const p of result.periods) {
    for (const [type, items] of [
      ["pl", p.pl],
      ["bs", p.bs],
    ] as const) {
      if (items.length === 0) continue;
      const { data: up, error: ue } = await supabase
        .from("financial_uploads")
        .insert({
          client_id: clientId,
          uploaded_by: session.user.id,
          statement_type: type,
          period_label: p.label,
          period_end: p.end,
          file_name: `MRP ${type.toUpperCase()} (${p.label})`,
          status: "confirmed",
        })
        .select("id")
        .single();
      if (ue || !up) return { error: ue?.message ?? "Could not record statement." };
      const { error: le } = await supabase.from("financial_line_items").insert(
        items.map((it, i) => ({
          upload_id: up.id,
          client_id: clientId,
          statement_type: type,
          raw_label: it.rawLabel,
          category: it.category,
          amount: it.amount,
          sort_order: i,
        }))
      );
      if (le) return { error: le.message };
      statements++;
    }
  }

  revalidatePath("/portal/financials");
  revalidatePath("/portal");
  return {
    ok: true,
    message: `Loaded ${result.periods.length} month${
      result.periods.length === 1 ? "" : "s"
    } (${statements} statements).${
      result.warnings.length ? " " + result.warnings.join(" ") : ""
    }`,
  };
}

export async function deleteUploadAction(
  uploadId: string
): Promise<{ ok?: boolean; error?: string }> {
  await requireSession();
  const supabase = await createClient();

  const { data: upload } = await supabase
    .from("financial_uploads")
    .select("source_path")
    .eq("id", uploadId)
    .single();

  if (upload?.source_path) {
    await supabase.storage.from(BUCKET).remove([upload.source_path]);
  }
  const { error } = await supabase
    .from("financial_uploads")
    .delete()
    .eq("id", uploadId);
  if (error) return { error: error.message };

  revalidatePath("/portal/financials");
  revalidatePath("/portal");
  return { ok: true };
}
