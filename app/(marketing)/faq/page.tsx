import type { Metadata } from "next";
import { Container, Section, Eyebrow } from "@/components/ui";
import { CtaBand } from "@/components/sections";
import { JsonLd } from "@/components/json-ld";
import { faqs } from "@/lib/site";
import { faqGraph } from "@/lib/structured-data";

export const metadata: Metadata = {
  title: "Fractional CFO FAQ",
  description:
    "Answers to common questions about hiring a fractional CFO: what it is, when you need one, how engagements work, and how Growth by the Numbers helps founder-led and PE-backed companies.",
};

export default function FaqPage() {
  return (
    <>
      <JsonLd data={faqGraph()} />

      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-80" />
        <Container className="relative py-20 sm:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <Eyebrow>FAQ</Eyebrow>
            <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
              Fractional CFO questions, answered straight.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/70">
              What a fractional CFO does, when it&apos;s time to bring one in,
              and how an engagement with Growth by the Numbers works.
            </p>
          </div>
        </Container>
      </section>

      {/* ── Questions ── */}
      <Section>
        <Container>
          <div className="mx-auto max-w-3xl divide-y divide-line">
            {faqs.map((f) => (
              <div key={f.q} className="py-8 first:pt-0 last:pb-0">
                <h2 className="text-xl font-bold text-ink">{f.q}</h2>
                <p className="mt-3 leading-relaxed text-muted">{f.a}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
