// Reload Floor Daddy's portal financials (Jan–Jun P&L + BS) from a refreshed
// MRP workbook — same clean-reload semantics as load-floor-daddy-financials-june,
// but data-only: the Documents tab is left alone.
//
//   node scripts/refresh-floor-daddy-financials-qbo.mjs [path-to-workbook.xlsx]
//
// Defaults to the QBO refresh workbook in the June month-end folder.
import { readFileSync } from "node:fs";
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

const FILE =
  process.argv[2] ??
  "C:/Users/Tyler/OneDrive/Growth by the Numbers/Floor Daddy/Financials/Month End/2026/06 - June/2026.07.17_Floor_Daddy_MRP_QBO_Refresh.xlsx";

const norm = (s) => String(s).toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();

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
  "other (ask my accountant)": "opex",
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

const MONTHS = [
  ["Jan 2026", "2026-01-31", 1, 2],
  ["Feb 2026", "2026-02-28", 2, 3],
  ["Mar 2026", "2026-03-31", 3, 4],
  ["Apr 2026", "2026-04-30", 4, 5],
  ["May 2026", "2026-05-31", 5, 6],
  ["Jun 2026", "2026-06-30", 6, 7],
];

function aoa(sheet) {
  const wb = XLSX.read(readFileSync(FILE));
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, blankrows: false });
}
function itemsFor(rows, map, col) {
  const out = [];
  for (const r of rows) {
    const label = r[0];
    if (label == null || String(label).trim() === "") continue;
    const cat = map[norm(label)];
    if (!cat) continue;
    const v = r[col];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out.push({ rawLabel: String(label).trim(), category: cat, amount: v });
  }
  return out;
}

async function main() {
  const { data: client } = await db.from("clients").select("id").eq("slug", "floor-daddy").single();
  if (!client) throw new Error("Floor Daddy client not found.");
  const cid = client.id;
  const { data: adminProfile } = await db.from("profiles").select("id").eq("role", "admin").limit(1).maybeSingle();
  const uploadedBy = adminProfile?.id ?? null;

  await db.from("financial_uploads").delete().eq("client_id", cid);
  const pl = aoa("DATA-PL");
  const bs = aoa("DATA-BS");

  for (const [label, end, plCol, bsCol] of MONTHS) {
    for (const [type, rows, col, mp] of [["pl", pl, plCol, PL_MAP], ["bs", bs, bsCol, BS_MAP]]) {
      const items = itemsFor(rows, mp, col);
      if (items.length === 0) continue;
      const { data: up, error: ue } = await db.from("financial_uploads").insert({
        client_id: cid, uploaded_by: uploadedBy, statement_type: type,
        period_label: label, period_end: end,
        file_name: `MRP ${type.toUpperCase()} (${label}) — QBO refresh`, status: "confirmed",
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
  console.log("\n✅ Portal financials reloaded from " + FILE.split("/").pop());
}
main().catch((e) => { console.error("✖", e.message || e); process.exit(1); });
