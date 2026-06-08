import type { Metadata } from "next";
import {
  Container,
  Section,
  Eyebrow,
  SectionHeading,
} from "@/components/ui";
import { StatBar, CtaBand } from "@/components/sections";
import { results } from "@/lib/site";

export const metadata: Metadata = {
  title: "Results",
  description:
    "Real outcomes from inside PE-backed and founder-led companies: $30M to $100M+ in revenue, 18% annual EBITDA growth, 20+ integrated acquisitions.",
};

export default function ResultsPage() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-80" />
        <Container className="relative py-20 sm:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <Eyebrow>Results</Eyebrow>
            <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
              The numbers behind the numbers.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/70">
              I don&apos;t sell theory. Here&apos;s what financial leadership has
              produced inside the companies I&apos;ve operated: the same
              playbook I bring to your business.
            </p>
          </div>
          <div className="mt-16">
            <StatBar dark />
          </div>
        </Container>
      </section>

      {/* ── Outcome cards ── */}
      <Section>
        <Container>
          <SectionHeading
            eyebrow="Selected outcomes"
            title="Value created, measured in the metrics that move enterprise value."
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            {results.map((r) => (
              <div
                key={r.title}
                className="relative overflow-hidden rounded-2xl border border-line bg-white p-8 ring-card"
              >
                <div className="absolute right-6 top-6 h-16 w-16 rounded-full bg-brand-50 blur-2xl" />
                <p className="relative text-4xl font-bold tracking-tight">
                  <span className="text-gradient">{r.metric}</span>
                </p>
                <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted-soft">
                  {r.sector}
                </p>
                <h3 className="mt-4 text-lg font-bold text-ink">{r.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {r.body}
                </p>
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-sm text-muted-soft">
            {/* TODO: Tyler, add named client case studies & testimonials as they're approved for use. */}
            Figures reflect outcomes achieved in roles as President, CFO, and
            integration leader. Detailed case studies available on request.
          </p>
        </Container>
      </Section>

      {/* ── What clients get from it ── */}
      <Section className="bg-paper-soft">
        <Container>
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
            <SectionHeading
              eyebrow="Why it matters"
              title="Every metric here ladders up to one thing: what your business is worth."
              intro="Revenue scaled. Margins expanded. Deals integrated. Costs renegotiated. Individually they're wins; together they're a more valuable, more durable, more sellable company."
            />
            <div className="grid gap-4">
              {[
                {
                  t: "For owners not selling",
                  d: "A business that runs on data, funds its own growth, and doesn't depend on you to keep score.",
                },
                {
                  t: "For owners eyeing an exit",
                  d: "Clean books, a credible KPI story, and the financial narrative buyers pay a premium for.",
                },
              ].map((c) => (
                <div
                  key={c.t}
                  className="rounded-2xl border border-line bg-white p-6 ring-soft"
                >
                  <h3 className="text-base font-bold text-ink">{c.t}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {c.d}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
