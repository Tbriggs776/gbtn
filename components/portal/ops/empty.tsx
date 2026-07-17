export function NoOrdersState() {
  return (
    <div className="rounded-lg border border-dashed border-line bg-white px-6 py-14 text-center">
      <p className="text-base font-semibold text-ink">No orders imported yet</p>
      <p className="mx-auto mt-1.5 max-w-lg text-sm text-muted">
        Export <span className="font-medium text-ink">Orders</span> from RFMS and import it here. Both
        reports read the same export — the Install Pipeline rolls lines up per CG, and the Orders
        Pipeline buckets them by day, week, and month.
      </p>
      <p className="mx-auto mt-3 max-w-lg text-xs text-muted-soft">
        The export needs at least the <span className="font-medium text-ink">Invoice_Num</span>,{" "}
        <span className="font-medium text-ink">LineNum</span>,{" "}
        <span className="font-medium text-ink">LineStatus</span>, and{" "}
        <span className="font-medium text-ink">OrderDate</span> columns.
      </p>
    </div>
  );
}
