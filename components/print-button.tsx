"use client";

export function PrintButton({ label = "Print / save PDF" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="font-label inline-flex items-center justify-center rounded-md bg-crimson px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-cream transition-all duration-200 hover:-translate-y-0.5 hover:brightness-110 print:hidden"
    >
      {label}
    </button>
  );
}
