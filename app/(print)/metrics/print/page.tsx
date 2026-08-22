import type { Metadata } from "next";
import Link from "next/link";
import { PrintButton } from "@/components/print-button";
import { metricGuide } from "@/lib/metric-guide";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "7 metrics one-pager",
  description:
    "Printable operator one-pager: the seven metrics that run a home-services or PE-backed platform.",
  robots: { index: false, follow: true },
};

export default function MetricsPrintPage() {
  return (
    <div className="min-h-screen bg-cream text-paper-ink">
      <div className="mx-auto max-w-3xl px-6 py-8 print:max-w-none print:px-0 print:py-0">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Link
            href="/metrics"
            className="text-sm font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            ← Back to the metrics page
          </Link>
          <PrintButton />
        </div>

        <article className="rounded-lg border border-line bg-white p-8 ring-soft print:rounded-none print:border-0 print:p-0 print:shadow-none">
          <header className="border-b border-crimson pb-4">
            <p className="font-label text-[11px] font-semibold uppercase tracking-[0.22em] text-crimson">
              {site.shortName} · Operator one-pager
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-navy-2">
              7 metrics that run your business
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Home services &amp; PE-backed operators. Run these weekly. One number
              drifting is a decision; seven drifting is a story you tell the board
              too late.
            </p>
          </header>

          <ol className="mt-6 divide-y divide-line">
            {metricGuide.map((m, i) => (
              <li key={m.name} className="grid grid-cols-[2.75rem_1fr] gap-3 py-3.5">
                <span className="font-label text-lg font-semibold text-crimson">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h2 className="text-base font-semibold text-navy-2">{m.name}</h2>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{m.why}</p>
                </div>
              </li>
            ))}
          </ol>

          <footer className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-muted-soft">
            <p>
              Growth by the Numbers · {site.founder.name} ·{" "}
              {site.url.replace("https://", "")} · {site.founder.email}
            </p>
            <p className="mt-1">
              Print this page (Ctrl/Cmd+P) and choose Save as PDF. Not advice; a
              scorecard. Book the diagnostic if the numbers don&apos;t match the
              story.
            </p>
          </footer>
        </article>
      </div>
    </div>
  );
}
