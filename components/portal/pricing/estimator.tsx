"use client";

import { useEffect, useMemo, useState, useActionState } from "react";
import {
  priceProduct,
  money,
  pct,
  type Assumptions,
} from "@/lib/pricing/engine";
import { updateAssumptionsAction, type PricingState } from "@/app/portal/pricing/actions";

type Product = {
  id: string;
  cat: "rolls" | "items" | "services";
  name: string;
  supplier: string;
  size: string;
  cost: number;
  comp: Record<string, number>;
};
type Line = { product: Product; qty: number };

const CATS = [
  { key: "all", label: "All" },
  { key: "rolls", label: "Rolls" },
  { key: "items", label: "Items" },
  { key: "services", label: "Services" },
] as const;

const COMP_LABELS: Record<string, string> = {
  Cut: "Cut",
  Pad: "Pad",
  ContLabor: "Cont labor",
  RetLabor: "Ret labor",
  Frt: "Freight",
  Item: "Item",
  Freight: "Freight",
  Spec: "Spec",
  Srvc: "Srvc",
  Load: "Load",
};

const initialSave: PricingState = {};

export function PricingEstimator({
  clientId,
  assumptions,
  isAdmin,
}: {
  clientId: string;
  assumptions: Assumptions;
  isAdmin: boolean;
}) {
  const [a, setA] = useState<Assumptions>(assumptions);
  const [catalog, setCatalog] = useState<Product[] | null>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<(typeof CATS)[number]["key"]>("all");
  const [lines, setLines] = useState<Line[]>([]);
  const [cashDiscount, setCashDiscount] = useState(false);
  const [discountPct, setDiscountPct] = useState(0);
  const [saveState, saveAction, saving] = useActionState(updateAssumptionsAction, initialSave);

  useEffect(() => {
    let live = true;
    fetch("/api/pricing/catalog?v=2", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Product[]) => live && setCatalog(d))
      .catch(() => live && setCatalog([]));
    return () => {
      live = false;
    };
  }, []);

  const results = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    return catalog
      .filter((p) => (cat === "all" ? true : p.cat === cat))
      .filter((p) =>
        q === "" ? true : p.name.toLowerCase().includes(q) || p.supplier.toLowerCase().includes(q)
      )
      .slice(0, 40);
  }, [catalog, query, cat]);

  function addProduct(p: Product) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product.id === p.id);
      if (i >= 0) {
        const copy = [...ls];
        copy[i] = { ...copy[i], qty: copy[i].qty + 1 };
        return copy;
      }
      return [...ls, { product: p, qty: 1 }];
    });
  }
  const setQty = (id: string, qty: number) =>
    setLines((ls) => ls.map((l) => (l.product.id === id ? { ...l, qty } : l)));
  const removeLine = (id: string) =>
    setLines((ls) => ls.filter((l) => l.product.id !== id));

  function costLine(l: Line) {
    const p = priceProduct(l.product.cost, a);
    const sellBase = cashDiscount ? p.cash : p.book;
    const unitSell = sellBase * (1 - discountPct);
    const financeCost = cashDiscount ? 0 : p.financeFee;
    const unitCost = p.productCost + p.commission + p.warranty + financeCost;
    return {
      p,
      unitSell,
      financeCost,
      sell: unitSell * l.qty,
      totalCost: unitCost * l.qty,
      gp: (unitSell - unitCost) * l.qty,
    };
  }

  const totals = useMemo(() => {
    let book = 0,
      cashSell = 0,
      sell = 0,
      totalCost = 0;
    for (const l of lines) {
      const c = costLine(l);
      book += c.p.book * l.qty;
      cashSell += c.p.cash * l.qty;
      sell += c.sell;
      totalCost += c.totalCost;
    }
    const cashDiscountAmt = cashDiscount ? book - cashSell : 0;
    const manualDiscountAmt = (book - cashDiscountAmt) * discountPct;
    const gp = sell - totalCost;
    const gm = sell > 0 ? (gp / sell) * 100 : null;
    return { book, cashDiscountAmt, manualDiscountAmt, sell, totalCost, gp, gm };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, a, cashDiscount, discountPct]);

  const empty = lines.length === 0;

  return (
    <div className="space-y-6">
      <AssumptionsCard a={a} setA={setA} isAdmin={isAdmin} clientId={clientId} saveAction={saveAction} saving={saving} saveState={saveState} />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        {/* Catalog search */}
        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <h3 className="text-sm font-bold text-ink">Catalog</h3>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 1,140 products…"
            className="mt-3 w-full rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
          <div className="mt-2 inline-flex rounded-lg border border-line p-0.5">
            {CATS.map((c) => (
              <button
                key={c.key}
                onClick={() => setCat(c.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                  cat === c.key ? "bg-ink text-cream" : "text-muted hover:text-ink"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto pr-1">
            {catalog === null ? (
              <p className="py-6 text-center text-sm text-muted-soft">Loading catalog…</p>
            ) : results.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-soft">No matches.</p>
            ) : (
              results.map((p) => {
                const r = priceProduct(p.cost, a);
                return (
                  <button
                    key={p.id}
                    onClick={() => addProduct(p)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-left transition-colors hover:border-navy-2 hover:bg-paper-soft"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{p.name}</p>
                      <p className="truncate text-[11px] text-muted-soft">{p.supplier} · {p.cat}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold text-ink">{money(r.cash)}</p>
                      <p className="text-[11px] text-muted-soft">cost {money(r.productCost)}</p>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Discounts */}
        <DiscountCard
          cashDiscount={cashDiscount}
          setCashDiscount={setCashDiscount}
          discountPct={discountPct}
          setDiscountPct={setDiscountPct}
          financeFee={a.financeFee}
        />
      </div>

      {/* Retail estimate */}
      <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
        <h3 className="text-sm font-bold text-ink">Retail estimate</h3>
        {empty ? (
          <p className="py-8 text-center text-sm text-muted-soft">
            Search the catalog above and click a product to add it.
          </p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-soft">
                    <th className="pb-2 font-semibold">Item</th>
                    <th className="pb-2 text-right font-semibold">Qty</th>
                    <th className="pb-2 text-right font-semibold">Unit price</th>
                    <th className="pb-2 text-right font-semibold">Line total</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const c = costLine(l);
                    return (
                      <tr key={l.product.id} className="border-t border-line">
                        <td className="py-2 pr-2">
                          <p className="font-medium text-ink">{l.product.name}</p>
                          <p className="text-[11px] text-muted-soft">{l.product.supplier} · {l.product.cat}</p>
                        </td>
                        <td className="py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            value={l.qty}
                            onChange={(e) => setQty(l.product.id, Math.max(0, Number(e.target.value)))}
                            className="w-16 rounded-md border border-line px-2 py-1 text-right text-sm focus:border-navy-2 focus:outline-none"
                          />
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted">{money(c.unitSell)}</td>
                        <td className="py-2 text-right font-semibold tabular-nums text-ink">{money(c.sell)}</td>
                        <td className="py-2 pl-2 text-right">
                          <button onClick={() => removeLine(l.product.id)} className="text-muted-soft hover:text-red-600" aria-label="Remove">
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 border-t-2 border-navy-2/20 pt-4">
              <div className="ml-auto max-w-sm space-y-1.5 text-sm">
                <Row label="Book price (list)" value={money(totals.book)} />
                {cashDiscount ? (
                  <Row label="Cash discount (waives finance fee)" value={`− ${money(totals.cashDiscountAmt)}`} sub />
                ) : null}
                {discountPct > 0 ? (
                  <Row label={`Additional discount (${(discountPct * 100).toFixed(0)}%)`} value={`− ${money(totals.manualDiscountAmt)}`} sub />
                ) : null}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-sm font-semibold text-ink">Customer total</span>
                  <span className="text-lg font-bold text-gradient">{money(totals.sell)}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Job costing */}
      <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
        <h3 className="text-sm font-bold text-ink">Job costing</h3>
        <p className="mt-0.5 text-xs text-muted-soft">Where the price comes from — and whether you&apos;re really hitting your GM.</p>
        {empty ? (
          <p className="py-8 text-center text-sm text-muted-soft">Add products above to see the cost breakdown.</p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-soft">
                    <th className="pb-2 font-semibold">Item / cost breakdown</th>
                    <th className="pb-2 text-right font-semibold">Qty</th>
                    <th className="pb-2 text-right font-semibold">Job cost</th>
                    <th className="pb-2 text-right font-semibold">Sell</th>
                    <th className="pb-2 text-right font-semibold">GM</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const c = costLine(l);
                    const lineGm = c.sell > 0 ? (c.gp / c.sell) * 100 : null;
                    const comps = Object.entries(l.product.comp ?? {}).filter(([, v]) => v > 0);
                    return (
                      <tr key={l.product.id} className="border-t border-line align-top">
                        <td className="py-2 pr-2">
                          <p className="font-medium text-ink">{l.product.name}</p>
                          <p className="mt-0.5 text-[11px] text-muted-soft">
                            {comps.map(([k, v]) => `${COMP_LABELS[k] ?? k} ${money(v)}`).join(" · ") || "—"}
                          </p>
                          <p className="text-[11px] text-muted-soft">
                            + comm {money(c.p.commission)} · warr {money(c.p.warranty)}
                            {c.financeCost > 0 ? ` · fin ${money(c.financeCost)}` : ""}
                          </p>
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted">{l.qty}</td>
                        <td className="py-2 text-right tabular-nums text-muted">{money(c.totalCost)}</td>
                        <td className="py-2 text-right font-semibold tabular-nums text-ink">{money(c.sell)}</td>
                        <td className={`py-2 text-right tabular-nums ${lineGm != null && lineGm < 40 ? "text-red-600" : "text-muted"}`}>
                          {pct(lineGm, 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 border-t-2 border-navy-2/20 pt-4">
              <div className="ml-auto max-w-sm space-y-1.5 text-sm">
                <Row label="Customer total" value={money(totals.sell)} />
                <Row label="Total job cost" value={money(totals.totalCost)} sub />
                <Row label="Gross profit" value={money(totals.gp)} strong />
                <div className="flex items-center justify-between pt-1">
                  <span className="text-sm font-semibold text-ink">Gross margin</span>
                  <span className={`text-lg font-bold ${totals.gm != null && totals.gm < 40 ? "text-red-600" : "text-gradient"}`}>
                    {pct(totals.gm, 1)}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, sub, strong }: { label: string; value: string; sub?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={sub ? "text-muted-soft" : strong ? "font-semibold text-ink" : "text-muted"}>{label}</span>
      <span className={`tabular-nums ${strong ? "font-bold text-ink" : sub ? "text-muted-soft" : "text-ink"}`}>{value}</span>
    </div>
  );
}

function DiscountCard({
  cashDiscount,
  setCashDiscount,
  discountPct,
  setDiscountPct,
  financeFee,
}: {
  cashDiscount: boolean;
  setCashDiscount: (v: boolean) => void;
  discountPct: number;
  setDiscountPct: (v: number) => void;
  financeFee: number;
}) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <h3 className="text-sm font-bold text-ink">Discounts</h3>
      <div className="mt-3 space-y-3">
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={cashDiscount}
            onChange={(e) => setCashDiscount(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-100"
          />
          <span>
            Cash discount (= finance fee, {(financeFee * 100).toFixed(0)}%)
            <span className="block text-[11px] text-muted-soft">Customer pays cash price; finance cost drops to $0.</span>
          </span>
        </label>
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-soft">Additional discount</label>
          <input
            type="number"
            min={0}
            max={50}
            step={0.5}
            value={Math.round(discountPct * 1000) / 10}
            onChange={(e) => setDiscountPct(Math.max(0, Number(e.target.value)) / 100)}
            className="w-16 rounded-md border border-line px-2 py-1.5 text-right text-sm focus:border-navy-2 focus:outline-none"
          />
          <span className="text-sm text-muted-soft">%</span>
        </div>
      </div>
    </div>
  );
}

function PercentInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-soft">{label}</label>
      <div className="flex items-center">
        <input
          type="number"
          step={0.5}
          min={0}
          max={99}
          disabled={disabled}
          value={Math.round(value * 1000) / 10}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
          className="w-20 rounded-md border border-line px-2 py-1.5 text-right text-sm focus:border-navy-2 focus:outline-none disabled:bg-paper-soft disabled:text-muted"
        />
        <span className="ml-1 text-sm text-muted-soft">%</span>
      </div>
    </div>
  );
}

function AssumptionsCard({
  a,
  setA,
  isAdmin,
  clientId,
  saveAction,
  saving,
  saveState,
}: {
  a: Assumptions;
  setA: (a: Assumptions) => void;
  isAdmin: boolean;
  clientId: string;
  saveAction: (formData: FormData) => void;
  saving: boolean;
  saveState: PricingState;
}) {
  return (
    <form action={saveAction} className="rounded-2xl border border-line bg-white p-5 ring-soft">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="commission" value={a.commission} />
      <input type="hidden" name="warranty" value={a.warranty} />
      <input type="hidden" name="gm" value={a.gm} />
      <input type="hidden" name="financeFee" value={a.financeFee} />

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink">Pricing assumptions</h3>
        {isAdmin ? (
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-ink px-4 py-1.5 text-xs font-semibold text-cream transition-colors hover:bg-ink-soft disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        ) : (
          <span className="text-[11px] text-muted-soft">Set by your advisor</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
        <PercentInput label="Commission" value={a.commission} onChange={(v) => setA({ ...a, commission: v })} disabled={!isAdmin} />
        <PercentInput label="Warranty" value={a.warranty} onChange={(v) => setA({ ...a, warranty: v })} disabled={!isAdmin} />
        <PercentInput label="Target GM" value={a.gm} onChange={(v) => setA({ ...a, gm: v })} disabled={!isAdmin} />
        <PercentInput label="Finance fee" value={a.financeFee} onChange={(v) => setA({ ...a, financeFee: v })} disabled={!isAdmin} />
      </div>

      {saveState.error ? <p className="mt-2 text-sm text-red-600">{saveState.error}</p> : null}
      {saveState.ok && saveState.message ? <p className="mt-2 text-sm text-brand-700">{saveState.message}</p> : null}
    </form>
  );
}
