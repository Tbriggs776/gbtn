import type { Metadata } from "next";
import {
  Container,
  Section,
  Button,
  Arrow,
  Check,
  Eyebrow,
  SectionHeading,
} from "@/components/ui";
import { ProcessSteps, CtaBand } from "@/components/sections";
import { services, addOns, audiences } from "@/lib/site";

export const metadata: Metadata = {
  title: "Services",
  description:
    "Profit by the Numbers, Scale by the Numbers, and Institutional-Grade Scale: a productized offer ladder for home-services operators and PE-backed platforms.",
};

export default function ServicesPage() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-80" />
        <Container className="relative py-20 text-center sm:py-28">
          <div className="mx-auto max-w-3xl">
            <Eyebrow>Services</Eyebrow>
            <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
              A productized path from{" "}
              <span className="text-gradient">diagnosis to scale.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/70">
              Start with a diagnostic, add a build phase, and (optionally) keep
              an ongoing cadence retainer. Every engagement is scoped to one
              outcome: predictable profit and cash.
            </p>
          </div>
        </Container>
      </section>

      {/* ── Service detail blocks ── */}
      <Section>
        <Container>
          <div className="space-y-8">
            {services.map((s, i) => (
              <div
                key={s.id}
                id={s.id}
                className="grid gap-8 rounded-3xl border border-line bg-white p-8 ring-soft sm:p-10 lg:grid-cols-[1fr_1.2fr] lg:gap-12"
              >
                <div>
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-brand text-sm font-bold text-white">
                      0{i + 1}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">
                      {s.tier}
                    </span>
                  </div>
                  <h2 className="mt-5 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                    {s.title}
                  </h2>
                  <p className="mt-4 text-base leading-relaxed text-muted">
                    {s.summary}
                  </p>
                  <div className="mt-6 grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-paper-soft p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">
                        Timeline
                      </p>
                      <p className="mt-1 text-sm font-bold text-ink">
                        {s.timeline}
                      </p>
                    </div>
                    <div className="rounded-xl bg-paper-soft p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">
                        Investment
                      </p>
                      <p className="mt-1 text-sm font-bold text-ink">
                        {s.price}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 rounded-xl bg-paper-soft p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft">
                      Best for
                    </p>
                    <p className="mt-1 text-sm font-medium text-ink">
                      {s.forWho}
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-line bg-paper-soft/60 p-6 sm:p-8">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/60">
                    What you get
                  </p>
                  <ul className="mt-5 space-y-3.5">
                    {s.deliverables.map((d) => (
                      <li
                        key={d}
                        className="flex items-start gap-3 text-sm leading-relaxed text-ink/85"
                      >
                        <Check className="text-brand-500" />
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      {/* ── Add-on modules ── */}
      <Section className="bg-paper-soft">
        <Container>
          <SectionHeading
            eyebrow="Add-on sprints"
            title="Targeted modules for a specific leak."
            intro="Bolt these onto any engagement, or run one standalone when you know exactly where the problem is."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {addOns.map((a) => (
              <div
                key={a.name}
                className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-white px-6 py-5 ring-soft"
              >
                <span className="text-sm font-semibold text-ink">{a.name}</span>
                <span className="shrink-0 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
                  {a.range}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-muted-soft">
            Pricing depends on entity complexity: locations, acquisitions, data
            cleanliness, and systems. Optional success-fee and advisory-equity
            structures available for the right fit.
          </p>
        </Container>
      </Section>

      {/* ── Who I serve ── */}
      <Section>
        <Container>
          <SectionHeading
            eyebrow="Who I serve"
            title="Two audiences. One operating system."
            align="center"
          />
          <div className="mx-auto mt-12 grid max-w-4xl gap-6 sm:grid-cols-2">
            {audiences.map((a) => (
              <div
                key={a.title}
                className="rounded-2xl border border-line bg-white p-7 ring-soft"
              >
                <h3 className="text-lg font-bold text-ink">{a.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {a.body}
                </p>
                <ul className="mt-5 space-y-2.5">
                  {a.points.map((p) => (
                    <li
                      key={p}
                      className="flex items-start gap-2.5 text-sm text-ink/80"
                    >
                      <Check className="text-brand-500" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      {/* ── Process ── */}
      <Section>
        <Container>
          <SectionHeading
            eyebrow="How it works"
            title="A clear path from financial fog to financial command."
            align="center"
          />
          <div className="mt-14">
            <ProcessSteps />
          </div>
          <div className="mt-12 text-center">
            <Button href="/contact" variant="primary">
              Start with a diagnostic <Arrow />
            </Button>
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
