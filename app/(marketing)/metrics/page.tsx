import type { Metadata } from "next";
import {
  Container,
  Section,
  Button,
  Arrow,
  Eyebrow,
  SectionHeading,
} from "@/components/ui";
import { CtaBand } from "@/components/sections";
import { WaitlistForm } from "@/components/waitlist-form";
import { metricGuide } from "@/lib/metric-guide";
import { book } from "@/lib/site";

export const metadata: Metadata = {
  title: "7 metrics that run your business",
  description:
    "The operator one-pager: seven numbers home-services and PE-backed platforms should run weekly. Email unlocks the printable sheet and the book waitlist.",
};

export default function MetricsPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-80" />
        <Container className="relative py-20 sm:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <Eyebrow>Lead magnet</Eyebrow>
            <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
              7 metrics that run your business.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/70">
              Not a dashboard dump. Seven numbers a home-services or PE-backed
              operator can run weekly — growth, margin, labor, concentration, and
              cash. Drop your email, print the one-pager, and you&apos;re on the
              book waitlist.
            </p>
          </div>

          <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-white/10 bg-white p-6 sm:p-8">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
              Unlock the one-pager
            </p>
            <h2 className="mt-2 text-xl font-bold tracking-tight text-ink">
              Print it. Stick it on the wall. Run it every week.
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Same waitlist as {book.title}. Source tagged as metrics so we know
              how you found us.
            </p>
            <WaitlistForm source="metrics" idPrefix="metrics" />
          </div>
        </Container>
      </section>

      <Section className="bg-paper-soft">
        <Container>
          <SectionHeading
            eyebrow="The seven"
            title="Why each one matters if you run crews, branches, or a roll-up."
            intro="One sentence each. No fluff. These are the same seven on the homepage — expanded just enough to act on."
          />
          <ol className="mt-12 grid gap-4">
            {metricGuide.map((m, i) => (
              <li
                key={m.name}
                className="grid gap-3 rounded-2xl border border-line bg-white p-6 ring-soft sm:grid-cols-[4.5rem_1fr] sm:items-start sm:gap-6 sm:p-7"
              >
                <span className="font-label text-2xl font-semibold text-crimson">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-ink">{m.name}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{m.why}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-10 text-sm text-muted">
            After you submit, you&apos;ll get a print-ready sheet. Or go straight to{" "}
            <a
              href="/metrics/print"
              className="font-semibold text-brand-700 underline-offset-4 hover:underline"
            >
              the one-pager
            </a>{" "}
            once you&apos;re on the list.
          </p>
        </Container>
      </Section>

      <Section>
        <Container>
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
            <SectionHeading
              eyebrow="Next"
              title="A sheet on the wall is the start. The cadence is the system."
              intro="If these seven are already leaking, the diagnostic engagement maps the drivers and the 90-day plan."
            />
            <Button href="/contact" variant="primary">
              Book a consultation <Arrow />
            </Button>
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
