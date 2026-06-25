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
};
type Line = { product: Product; qty: number };

const CATS = [
  { key: "all", label: "All" },
  { key: "rolls", label: "Rolls" },
  { key: "items", label: "Items" },
  { key: "services", label: "Services" },
] as const;

const unitLabel = (cat: Product["cat"]) =>
  cat === "rolls" ? "sq ft" : cat === "services" ? "ea" : "unit";

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
  const [saveState, saveAction, saving] = useActionState(updateAssumptionsAction, initialSave);

  useEffect(() => {
    let live = true;
    fetch("/api/pricing/catalog")
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

  // Totals across the estimate.
  const totals = useMemo(() => {
    let cost = 0;
    let cash = 0;
    const tierTotals = a.tiers.map(() => 0);
    for (const l of lines) {
      const r = priceProduct(l.product.cost, a);
      cost += r.cost * l.qty;
      cash += r.cash * l.qty;
      r.tiers.forEach((t, i) => (tierTotals[i] += t.book * l.qty));
    }
    const marginPct = cash > 0 ? ((cash - cost) / cash) * 100 : null;
    return { cost, cash, marginPct, tierTotals };
  }, [lines, a]);

  return (
    <div className="space-y-6">
      {/* Assumptions */}
      <Assumptions a={a} setA={setA} isAdmin={isAdmin} clientId={clientId} saveAction={saveAction} saving={saving} saveState={saveState} />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        {/* Search / catalog */}
        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <h3 className="text-sm font-bold text-ink">Catalog</h3>
          <div className="mt-3 flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 1,140 products…"
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </div>
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

          <div className="mt-3 max-h-96 space-y-1.5 overflow-y-auto pr-1">
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
                      <p className="truncate text-[11px] text-muted-soft">
                        {p.supplier} · {p.cat} {p.size ? `· ${p.size}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold text-ink">{money(r.cash)}</p>
                      <p className="text-[11px] text-muted-soft">cost {money(r.cost)}</p>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Estimate */}
        <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
          <h3 className="text-sm font-bold text-ink">Estimate</h3>
          {lines.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-soft">
              Search the catalog and click a product to add it.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-muted-soft">
                    <th className="pb-2 font-semibold">Product</th>
                    <th className="pb-2 text-right font-semibold">Qty</th>
                    <th className="pb-2 text-right font-semibold">Unit cash</th>
                    <th className="pb-2 text-right font-semibold">GM</th>
                    <th className="pb-2 text-right font-semibold">Line</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const r = priceProduct(l.product.cost, a);
                    return (
                      <tr key={l.product.id} className="border-t border-line">
                        <td className="py-2 pr-2">
                          <p className="font-medium text-ink">{l.product.name}</p>
                          <p className="text-[11px] text-muted-soft">
                            cost {money(r.cost)} / {unitLabel(l.product.cat)}
                          </p>
                        </td>
                        <td className="py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            step={l.product.cat === "rolls" ? 1 : 1}
                            value={l.qty}
                            onChange={(e) => setQty(l.product.id, Math.max(0, Number(e.target.value)))}
                            className="w-20 rounded-md border border-line px-2 py-1 text-right text-sm focus:border-navy-2 focus:outline-none"
                          />
                        </td>
                        <td className="py-2 text-right tabular-nums text-ink">{money(r.cash)}</td>
                        <td className="py-2 text-right tabular-nums text-muted">{pct(r.marginPct, 0)}</td>
                        <td className="py-2 text-right font-semibold tabular-nums text-ink">
                          {money(r.cash * l.qty)}
                        </td>
                        <td className="py-2 pl-2 text-right">
                          <button
                            onClick={() => removeLine(l.product.id)}
                            className="text-muted-soft hover:text-red-600"
                            aria-label="Remove"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Totals */}
          {lines.length > 0 && (
            <div className="mt-4 space-y-3 border-t-2 border-navy-2/20 pt-4">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Total cost" value={money(totals.cost)} />
                <Stat label="Cash price" value={money(totals.cash)} accent />
                <Stat label="Blended GM" value={pct(totals.marginPct, 1)} />
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-soft">
                  Financed (whole job, by program)
                </p>
                <div className="flex flex-wrap gap-2">
                  {a.tiers.map((t, i) => (
                    <div key={i} className="rounded-lg border border-line bg-paper-soft px-3 py-1.5">
                      <span className="text-[11px] text-muted-soft">{(t * 100).toFixed(0)}% · </span>
                      <span className="text-sm font-semibold text-ink">{money(totals.tierTotals[i])}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-paper-soft p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-soft">{label}</p>
      <p className={`mt-1 text-lg font-bold tracking-tight ${accent ? "text-gradient" : "text-ink"}`}>
        {value}
      </p>
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
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-soft">
        {label}
      </label>
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

function Assumptions({
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
      {a.tiers.map((t, i) => (
        <input key={i} type="hidden" name="tiers" value={t} />
      ))}

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
        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-soft">
            Finance programs
          </label>
          <div className="flex gap-2">
            {a.tiers.map((t, i) => (
              <div key={i} className="flex items-center">
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  max={99}
                  disabled={!isAdmin}
                  value={Math.round(t * 1000) / 10}
                  onChange={(e) => {
                    const tiers = [...a.tiers];
                    tiers[i] = Number(e.target.value) / 100;
                    setA({ ...a, tiers });
                  }}
                  className="w-14 rounded-md border border-line px-2 py-1.5 text-right text-sm focus:border-navy-2 focus:outline-none disabled:bg-paper-soft disabled:text-muted"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {saveState.error ? <p className="mt-2 text-sm text-red-600">{saveState.error}</p> : null}
      {saveState.ok && saveState.message ? (
        <p className="mt-2 text-sm text-brand-700">{saveState.message}</p>
      ) : null}
      <p className="mt-2 text-[11px] text-muted-soft">
        Cash price = cost ÷ [(1−GM)(1−warranty) − commission]. Change any lever and every price updates live.
      </p>
    </form>
  );
}
