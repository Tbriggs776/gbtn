// Add Floor Daddy's June-2026 month-end docs to Documents AND (clean) reload the
// Jan–Jun P&L + Balance Sheet into the portal's financial tables so dashboards
// render through June. Source of truth: the June MRP_FINAL_v3 workbook, which
// carries every month Jan–Jun in its DATA-PL / DATA-BS tabs.
// Run: node scripts/load-floor-daddy-financials-june.mjs
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

function loadEnv(p) {
  const e = {};
  for (const l of readFileSync(p, "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith("#")) e[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return e;
}
const env = loadEnv(new URL("../.env.local", import.meta.url));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BUCKET = "client-files";
const ROOT = "C:/Users/Tyler/OneDrive/Growth by the Numbers/Floor Daddy/Financials/Month End/";
const DIR = ROOT + "2026/06 - June/";
const XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// [absolute source path, destination name in portal, content type]
const FILES = [
  [DIR + "2026.06.30_Floor_Daddy_MRP_FINAL_v3.pdf", "June 2026 Financial Package.pdf", "application/pdf"],
  [DIR + "2026.06.30_Floor_Daddy_MRP_FINAL_v3.xlsx", "MRP - June 2026.xlsx", XLSX_CT],
  [ROOT + "2026.06.30_Customer Deposit.xlsx", "Customer Deposits (June 2026).xlsx", XLSX_CT],
];

const norm = (s) => String(s).toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
const safe = (s) => s.replace(/[^a-zA-Z0-9.\-_]+/g, "_").slice(0, 180);

const PL_MAP = {
  "net revenue": "revenue",
  "cost of labor - installers": "cogs", "supplies & materials": "cogs",
  "dc commissions": "cogs", "finance costs": "cogs", "subcontractors": "cogs",
  "product storage": "cogs", "freight in": "cogs", "referral fees": "cogs",
  "claims (house/installer/material)": "cogs",
  "advertising & marketing": "opex", "payroll expense": "opex",
  "office & software": "opex", "vehicle expense": "opex", "legal & accounting": "opex",
  "rent & occupancy": "opex", "guaranteed payments": "opex", "utilities": "opex",
  "insurance": "opex", "other operating": "opex",
  "depreciation": "depreciation_amortization", "interest expense": "interest",
};
const BS_MAP = {
  "cash & bank": "cash", "accounts receivable": "accounts_receivable",
  "cwip": "other_current_asset", "claims receivable": "other_current_asset",
  "other current assets (draws/adv)": "other_current_asset",
  "fixed assets, net": "non_current_asset", "other assets": "non_current_asset",
  "accounts payable": "accounts_payable", "credit cards": "other_current_liability",
  "customer deposits": "other_current_liability",
  "accrued & other current liab": "other_current_liability",
  "shareholder loans": "non_current_liability",
  "notes payable (current)": "other_current_liability",
  "long-term debt": "non_current_liability",
  "total equity (members' deficit)": "equity",
};

// month label -> { end, plCol (Jan=1..Jun=6), bsCol (Jan=2..Jun=7) }
const MONTHS = [
  ["Jan 2026", "2026-01-31", 1, 2],
  ["Feb 2026", "2026-02-28", 2, 3],
  ["Mar 2026", "2026-03-31", 3, 4],
  ["Apr 2026", "2026-04-30", 4, 5],
  ["May 2026", "2026-05-31", 5, 6],
  ["Jun 2026", "2026-06-30", 6, 7],
];

const TPL = "2026.06.30_Floor_Daddy_MRP_FINAL_v3.xlsx";

function aoa(file, sheet) {
  const wb = XLSX.read(readFileSync(DIR + file));
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, blankrows: false });
}
function itemsFor(rows, map, col) {
  const out = [];
  for (const r of rows) {
    const label = r[0];
    if (label == null || String(label).trim() === "") continue;
    const cat = map[norm(label)];
    if (!cat) continue; // unmapped (subtotals/headers) -> skip
    const v = r[col];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out.push({ rawLabel: String(label).trim(), category: cat, amount: v });
  }
  return out;
}

async function main() {
  const { data: client } = await db.from("clients").select("id").eq("slug", "floor-daddy").single();
  if (!client) throw new Error("Floor Daddy client not found — run provision-floor-daddy first.");
  const cid = client.id;
  const { data: adminProfile } = await db.from("profiles").select("id").eq("role", "admin").limit(1).maybeSingle();
  const uploadedBy = adminProfile?.id ?? null;

  // ── 1. Documents (replace by name: delete any existing with the same name, re-upload)
  const { data: existing } = await db
    .from("documents")
    .select("id, file_name, storage_path")
    .eq("client_id", cid);
  const byName = {};
  for (const d of existing ?? []) (byName[d.file_name] ??= []).push(d);

  for (const [src, name, ct] of FILES) {
    if (!existsSync(src)) { console.log(`  ✖ missing file: ${src}`); continue; }
    const dups = byName[name] ?? [];
    for (const d of dups) {
      if (d.storage_path) await db.storage.from(BUCKET).remove([d.storage_path]);
      await db.from("documents").delete().eq("id", d.id);
    }
    const buf = readFileSync(src);
    const path = `${cid}/${crypto.randomUUID()}-${safe(name)}`;
    const { error: ue } = await db.storage.from(BUCKET).upload(path, buf, { contentType: ct, upsert: false });
    if (ue) { console.log(`  ✖ upload ${name}: ${ue.message}`); continue; }
    const { error: re } = await db.from("documents").insert({
      client_id: cid, uploaded_by: uploadedBy, storage_path: path, file_name: name,
      byte_size: buf.length, content_type: ct, category: "Financials",
    });
    console.log(
      re ? `  ✖ record ${name}: ${re.message}`
         : `  ${dups.length ? "↻ replaced" : "✓ added"}: ${name} (${buf.length}b)`
    );
  }

  // ── 2. Financials (clean reload of Jan–Jun from the FINAL_v3 workbook) ──────
  await db.from("financial_uploads").delete().eq("client_id", cid);
  const pl = aoa(TPL, "DATA-PL");
  const bs = aoa(TPL, "DATA-BS");

  for (const [label, end, plCol, bsCol] of MONTHS) {
    for (const [type, rows, col, mp] of [["pl", pl, plCol, PL_MAP], ["bs", bs, bsCol, BS_MAP]]) {
      const items = itemsFor(rows, mp, col);
      if (items.length === 0) continue;
      const { data: up, error: ue } = await db.from("financial_uploads").insert({
        client_id: cid, uploaded_by: uploadedBy, statement_type: type,
        period_label: label, period_end: end,
        file_name: `MRP ${type.toUpperCase()} (${label})`, status: "confirmed",
      }).select("id").single();
      if (ue) { console.log(`  ✖ upload ${type} ${label}: ${ue.message}`); continue; }
      const { error: le } = await db.from("financial_line_items").insert(
        items.map((it, i) => ({
          upload_id: up.id, client_id: cid, statement_type: type,
          raw_label: it.rawLabel, category: it.category, amount: it.amount, sort_order: i,
        }))
      );
      console.log(le ? `  ✖ items ${type} ${label}: ${le.message}` : `  ✓ ${type.toUpperCase()} ${label}: ${items.length} lines`);
    }
  }
  console.log("\n✅ Floor Daddy documents + Jan-Jun financials loaded.");
}
main().catch((e) => { console.error("✖", e.message || e); process.exit(1); });
