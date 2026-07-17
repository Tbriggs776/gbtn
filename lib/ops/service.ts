import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ParsedOrders } from "./csv-import";
import type { OrderLine } from "./pipeline";

// Service-role reads/writes for ops_order_lines. Every caller must already have
// verified the caller's membership of the client (see actions.ts) — the service
// role bypasses RLS by design, exactly as lib/google-ads/service.ts does.

const CHUNK = 1000;

/**
 * Replace this client's order lines with the export's.
 *
 * An RFMS Orders export is a full snapshot, not a delta: a line that has been
 * deleted in RFMS simply stops appearing. Upserting alone would leave those
 * ghosts behind forever, so we delete the client's rows and reload inside the
 * same call. Scoped to one client, and the table is small (~2k rows/client).
 */
export async function loadOrders(clientId: string, parsed: ParsedOrders): Promise<number> {
  const admin = createAdminClient();

  const rows = parsed.lines.map((l) => ({
    client_id: clientId,
    invoice_num: l.invoiceNum,
    line_num: l.lineNum,
    line_status: l.lineStatus,
    pc: l.pc,
    line_class: l.lineClass,
    cust_name: l.custName,
    ship_city: l.shipCity,
    ship_state: l.shipState,
    salesperson: l.salesperson,
    job_type: l.jobType,
    ad_source: l.adSource,
    order_date: l.orderDate,
    install_date: l.installDate,
    est_del_date: l.estDelDate,
    measure_date: l.measureDate,
    style_item: l.styleItem,
    color_desc: l.colorDesc,
    line_group: l.lineGroup,
    supplier: l.supplier,
    po_number: l.poNumber,
    uom: l.uom,
    qty: l.qty,
    unit_price: l.unitPrice,
    line_total: l.lineTotal,
    total_cost: l.totalCost,
    raw: l.raw,
  }));

  const { error: delErr } = await admin.from("ops_order_lines").delete().eq("client_id", clientId);
  if (delErr) throw new Error(`Could not clear existing orders: ${delErr.message}`);

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await admin.from("ops_order_lines").insert(rows.slice(i, i + CHUNK));
    if (error) throw new Error(`ops_order_lines: ${error.message}`);
  }
  return rows.length;
}

export async function hasOrders(clientId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("ops_order_lines")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if (error) return false;
  return (count ?? 0) > 0;
}

/**
 * Every line for a client. Both reports need the full set — the Install Pipeline
 * rolls lines up per CG and the Orders Pipeline buckets them by date — and the
 * table is ~2k rows per client, so one read beats a query per view.
 * Supabase caps a select at 1000 rows by default, hence the explicit paging.
 */
export async function listOrderLines(clientId: string): Promise<OrderLine[]> {
  const admin = createAdminClient();
  const out: OrderLine[] = [];
  const PAGE = 1000;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("ops_order_lines")
      .select(
        "invoice_num, line_num, line_status, line_class, cust_name, ship_city, salesperson, job_type, order_date, install_date, est_del_date, measure_date, style_item, qty, line_total"
      )
      .eq("client_id", clientId)
      .order("invoice_num", { ascending: true })
      .order("line_num", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    for (const r of data) {
      out.push({
        invoiceNum: r.invoice_num as string,
        lineNum: r.line_num as number,
        lineStatus: r.line_status as OrderLine["lineStatus"],
        lineClass: r.line_class as OrderLine["lineClass"],
        custName: (r.cust_name as string) ?? "",
        shipCity: (r.ship_city as string) ?? "",
        salesperson: (r.salesperson as string) ?? "",
        jobType: (r.job_type as string) ?? "",
        orderDate: (r.order_date as string) ?? null,
        installDate: (r.install_date as string) ?? null,
        estDelDate: (r.est_del_date as string) ?? null,
        measureDate: (r.measure_date as string) ?? null,
        styleItem: (r.style_item as string) ?? "",
        qty: Number(r.qty ?? 0),
        lineTotal: Number(r.line_total ?? 0),
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * One CG's lines, for the board's row expansion. The full export runs ~20 lines
 * per CG across 800+ CGs, so shipping every line to the browser up front costs
 * ~6MB; this fetches the ~20 that a user actually opened.
 */
export async function listLinesForCG(clientId: string, invoiceNum: string): Promise<OrderLine[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ops_order_lines")
    .select(
      "invoice_num, line_num, line_status, line_class, cust_name, ship_city, salesperson, job_type, order_date, install_date, est_del_date, measure_date, style_item, qty, line_total"
    )
    .eq("client_id", clientId)
    .eq("invoice_num", invoiceNum)
    .order("line_num", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    invoiceNum: r.invoice_num as string,
    lineNum: r.line_num as number,
    lineStatus: r.line_status as OrderLine["lineStatus"],
    lineClass: r.line_class as OrderLine["lineClass"],
    custName: (r.cust_name as string) ?? "",
    shipCity: (r.ship_city as string) ?? "",
    salesperson: (r.salesperson as string) ?? "",
    jobType: (r.job_type as string) ?? "",
    orderDate: (r.order_date as string) ?? null,
    installDate: (r.install_date as string) ?? null,
    estDelDate: (r.est_del_date as string) ?? null,
    measureDate: (r.measure_date as string) ?? null,
    styleItem: (r.style_item as string) ?? "",
    qty: Number(r.qty ?? 0),
    lineTotal: Number(r.line_total ?? 0),
  }));
}

/** The export's freshness — shown so nobody reads a stale board as live. */
export async function lastImportedAt(clientId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ops_order_lines")
    .select("imported_at")
    .eq("client_id", clientId)
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.imported_at as string;
}
