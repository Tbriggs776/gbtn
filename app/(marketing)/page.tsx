import Link from "next/link";
import {
  Container,
  Section,
  Button,
  Arrow,
  Check,
  Eyebrow,
  SectionHeading,
  Card,
} from "@/components/ui";
import {
  StatBar,
  LogoWall,
  ProcessSteps,
  CtaBand,
} from "@/components/sections";
import {
  services,
  differentiators,
  trackRecord,
  site,
  levers,
  metrics,
  book,
} from "@/lib/site";

export default function HomePage() {
  return (
    <>
      {/* ───────────────── Hero ───────────────── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-32 h-[28rem]" />
        <div className="absolute -right-40 top-10 h-96 w-96 rounded-full bg-brand-500/10 blur-3xl" />
        <Container className="relative pt-20 pb-24 sm:pt-28 sm:pb-32">
          <div className="mx-auto max-w-3xl text-center">
            <span className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-white/80 backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />
              Operator CFO · Home Services &amp; PE-Backed Platforms
            </span>
            <h1 className="animate-fade-up mt-6 text-balance text-4xl font-bold tracking-tight text-white sm:text-6xl">
              You&apos;re growing on gut. We&apos;ll help you grow{" "}
              <span className="text-gradient">by the numbers.</span>
            </h1>
            <p className="animate-fade-up mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/70">
              Most operators are flying blind: revenue up, profit flat, and no
              system to tell them why. Growth by the Numbers installs the finance
              engine that turns growth into predictable profit and cash. Led by
              Tyler Briggs, who scaled a PE-backed home-services platform from{" "}
              <span className="font-semibold text-white">$30M to $100M+</span>.
            </p>
            <div className="animate-fade-up mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button href="/contact" variant="primary">
                Book a consultation <Arrow />
              </Button>
              <Button href="/about" variant="light">
                Meet your CFO
              </Button>
            </div>
          </div>

          <div className="animate-fade-up mt-16">
            <StatBar dark />
          </div>
        </Container>
      </section>

      {/* ───────────────── Logo wall ───────────────── */}
      <LogoWall />

      {/* ───────────────── The problem / wedge ───────────────── */}
      <Section>
        <Container>
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div>
              <SectionHeading
                eyebrow="The gap"
                title="Your bookkeeper keeps score. You need someone who can change it."
                intro="Most growing companies have someone recording history, and no one engineering the future. Clean books tell you what happened. They don't tell you where the margin is hiding, whether you can afford the next hire, or what your business is worth to a buyer."
              />
              <p className="mt-5 text-lg leading-relaxed text-muted">
                That&apos;s the difference between accounting and a CFO. I sit
                on the strategy side of the numbers: forecasting cash,
                pressure-testing decisions, and building the financial engine
                that compounds value quarter after quarter.
              </p>
              <div className="mt-8">
                <Link
                  href="/services"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-600"
                >
                  See how I work <Arrow />
                </Link>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {differentiators.map((d) => (
                <Card key={d.title} className="p-6">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600">
                    <Check className="text-brand-600" />
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-ink">
                    {d.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {d.body}
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </Container>
      </Section>

      {/* ───────────────── Services ───────────────── */}
      <Section className="bg-paper-soft">
        <Container>
          <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
            <SectionHeading
              eyebrow="The offer ladder"
              title="Three productized engagements. One outcome: predictable profit and cash."
            />
            <Button href="/services" variant="ghost">
              All services <Arrow />
            </Button>
          </div>

          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {services.map((s) => (
              <div
                key={s.id}
                className="group flex flex-col rounded-2xl border border-line bg-white p-7 ring-card transition-all duration-200 hover:-translate-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-600">
                    {s.tier}
                  </span>
                  <span className="text-xs font-medium text-muted-soft">
                    {s.timeline}
                  </span>
                </div>
                <h3 className="mt-3 text-xl font-bold tracking-tight text-ink">
                  {s.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-muted">
                  {s.summary}
                </p>
                <ul className="mt-6 space-y-2.5">
                  {s.deliverables.slice(0, 3).map((d) => (
                    <li
                      key={d}
                      className="flex items-start gap-2.5 text-sm text-ink/80"
                    >
                      <Check className="text-brand-500" />
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex items-center justify-between pt-6">
                  <span className="text-sm font-semibold text-ink">
                    {s.price}
                  </span>
                  <Link
                    href="/services"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 transition-colors group-hover:text-brand-600"
                  >
                    Details <Arrow />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      {/* ───────────────── The method (levers + metrics) ───────────────── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-20 h-64" />
        <Container className="relative py-20 sm:py-28">
          <SectionHeading
            eyebrow="The method"
            title="Three levers. Seven metrics. One operating system."
            intro="Every decision in your business moves three levers, and seven numbers tell you whether you're winning. That's the whole framework. Simple enough to run weekly, powerful enough to scale on."
            dark
          />

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {levers.map((l) => (
              <div
                key={l.title}
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-7 backdrop-blur"
              >
                <span className="text-gradient text-3xl font-bold tracking-tight">
                  {l.num}
                </span>
                <h3 className="mt-3 text-lg font-semibold text-white">
                  {l.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-white/60">
                  {l.body}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-400">
              The 7 metrics that run your business
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              {metrics.map((m) => (
                <span
                  key={m}
                  className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white/80"
                >
                  {m}
                </span>
              ))}
            </div>
          </div>
        </Container>
      </section>

      {/* ───────────────── Track record highlight ───────────────── */}
      <Section>
        <Container>
          <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
            <SectionHeading
              eyebrow="The track record"
              title="A résumé of value created, not just hours billed."
              intro="I've spent my career inside the companies private equity builds, sitting in the President and CFO seats, integrating acquisitions, and answering to boards. This is the experience your business gets access to."
            />
            <div className="space-y-4">
              {trackRecord.slice(0, 3).map((t) => (
                <div
                  key={t.company}
                  className="rounded-2xl border border-line bg-white p-6 ring-soft"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-base font-bold text-ink">
                      {t.company}
                    </h3>
                    <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                      {t.backer}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm font-medium text-muted">
                    {t.role} · {t.period}
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-ink/80">
                    {t.highlight}
                  </p>
                </div>
              ))}
              <Link
                href="/about"
                className="inline-flex items-center gap-2 px-1 text-sm font-semibold text-brand-700 hover:text-brand-600"
              >
                See the full track record <Arrow />
              </Link>
            </div>
          </div>
        </Container>
      </Section>

      {/* ───────────────── Process ───────────────── */}
      <Section className="bg-paper-soft">
        <Container>
          <SectionHeading
            eyebrow="How it works"
            title="A clear path from financial fog to financial command."
            align="center"
          />
          <div className="mt-14">
            <ProcessSteps />
          </div>
        </Container>
      </Section>

      {/* ───────────────── Book ───────────────── */}
      <Section className="bg-paper-soft">
        <Container>
          <div className="grid items-center gap-8 rounded-3xl border border-line bg-white p-8 ring-soft sm:p-10 lg:grid-cols-[1.4fr_1fr] lg:gap-12">
            <div>
              <Eyebrow>The book</Eyebrow>
              <h3 className="mt-4 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
                {book.title}
              </h3>
              <p className="mt-1 text-base font-medium text-brand-700">
                {book.subtitle}
              </p>
              <p className="mt-4 text-base leading-relaxed text-muted">
                {book.blurb}
              </p>
              <div className="mt-6">
                <Button href="/contact" variant="secondary">
                  Get on the list <Arrow />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {metrics.map((m) => (
                <span
                  key={m}
                  className="rounded-full border border-line bg-paper-soft px-4 py-2 text-sm font-medium text-ink/75"
                >
                  {m}
                </span>
              ))}
            </div>
          </div>
        </Container>
      </Section>

      {/* ───────────────── Testimonial placeholder ───────────────── */}
      <Section>
        <Container>
          <figure className="mx-auto max-w-3xl text-center">
            <div className="text-gradient text-5xl font-bold leading-none">
              &ldquo;
            </div>
            <blockquote className="mt-4 text-balance text-2xl font-medium leading-relaxed tracking-tight text-ink sm:text-3xl">
              {/* TODO: replace with a real client testimonial */}
              Tyler walked into a fast-growth mess and gave us a financial
              operating system. For the first time, we made decisions on data
              instead of gut.
            </blockquote>
            <figcaption className="mt-6 text-sm font-medium text-muted">
              {/* TODO: real attribution */}
              Owner &amp; Founder, PE-backed home services platform
            </figcaption>
          </figure>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
