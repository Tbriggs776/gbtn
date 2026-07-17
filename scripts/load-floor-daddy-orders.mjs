// Seed Floor Daddy's RFMS Orders export into ops_order_lines so the Ops Reports
// section has data without a manual upload. Same snapshot semantics as the
// in-app importer: this REPLACES the client's order lines.
//
//   node scripts/load-floor-daddy-orders.mjs [path-to-export.csv]
//
// Defaults to the July 2026 export in OneDrive.
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

const DEFAULT = "C:/Users/Tyler/Downloads/2026.07.16-Orders2.CSV";
const FILE = process.argv[2] ?? DEFAULT;

const STATUSES = ["None", "GenPO", "OnOrder", "Resvd", "Cut", "Del"];

// Mirrors lib/ops/pc.ts — keep the two in step.
const classifyPC = (pc) => {
  const n = parseInt(String(pc ?? "").trim(), 10);
  if (!Number.isFinite(n)) return "other";
  if (n < 70) return "material";
  if (n < 90) return "labor";
  return "other";
};

const str = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/^"+|"+$/g, "").trim();
  return s === "" ? null : s;
};
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const ymd = (v) => {
  const s = str(v);
  if (!s || !/^\d{8}$/.test(s)) return null;
  const [y, m, d] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${m}-${d}`;
};
const status = (v) => {
  const s = str(v);
  if (!s) return "None";
  return STATUSES.find((k) => k.toLowerCase() === s.toLowerCase()) ?? "None";
};

async function main() {
  if (!existsSync(FILE)) throw new Error(`No such file: ${FILE}`);

  const { data: client } = await db.from("clients").select("id, name").eq("slug", "floor-daddy").single();
  if (!client) throw new Error("Floor Daddy client not found — run provision-floor-daddy first.");

  const wb = XLSX.read(readFileSync(FILE), { type: "buffer", raw: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: "" });
  console.log(`Read ${rows.length} rows from ${FILE.split("/").pop()}`);

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const invoice_num = str(r["Invoice_Num"]);
    const line_num = num(r["LineNum"]);
    if (!invoice_num || line_num === null) continue;
    const key = `${invoice_num}#${line_num}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const pc = str(r["PC"]);
    out.push({
      client_id: client.id,
      invoice_num,
      line_num,
      line_status: status(r["LineStatus"]),
      pc,
      line_class: classifyPC(pc),
      cust_name: str(r["CustName"]),
      ship_city: str(r["ShipToCity"]),
      ship_state: str(r["ShipToState"]),
      salesperson: str(r["Salesperson"]),
      job_type: str(r["JobType"]),
      ad_source: str(r["AdSource"]),
      order_date: ymd(r["OrderDate"]),
      install_date: ymd(r["InstallDate"]),
      est_del_date: ymd(r["EstDelDate"]),
      measure_date: ymd(r["&Measure Date"]),
      style_item: str(r["StyleItem"]),
      color_desc: str(r["ColorDesc"]),
      line_group: str(r["LineGroup"]),
      supplier: str(r["Supplier"]),
      po_number: str(r["PO Number"]),
      uom: str(r["UOM"]),
      qty: num(r["Qty"]),
      unit_price: num(r["UnitPrice"]),
      line_total: num(r["LineTotal"]),
      total_cost: num(r["TotalCost"]),
      raw: r,
    });
  }

  const { error: delErr } = await db.from("ops_order_lines").delete().eq("client_id", client.id);
  if (delErr) throw new Error(delErr.message);

  for (let i = 0; i < out.length; i += 500) {
    const { error } = await db.from("ops_order_lines").insert(out.slice(i, i + 500));
    if (error) throw new Error(error.message);
    process.stdout.write(`  inserted ${Math.min(i + 500, out.length)}/${out.length}\r`);
  }

  const cgs = new Set(out.map((r) => r.invoice_num)).size;
  const mix = {};
  for (const r of out) mix[r.line_status] = (mix[r.line_status] ?? 0) + 1;
  const cls = {};
  for (const r of out) cls[r.line_class] = (cls[r.line_class] ?? 0) + 1;
  const boiler = out.filter((r) => !r.qty && !r.line_total).length;
  const dates = out.map((r) => r.order_date).filter(Boolean).sort();
  console.log(`\n✅ ${client.name}: ${out.length} lines across ${cgs} CGs`);
  console.log("   ordered:    ", dates[0], "->", dates[dates.length - 1]);
  console.log("   status mix: ", JSON.stringify(mix));
  console.log("   line class: ", JSON.stringify(cls));
  console.log(`   boilerplate: ${boiler} lines (qty 0 and value 0)`);
}
main().catch((e) => {
  console.error("✖", e.message || e);
  process.exit(1);
});
