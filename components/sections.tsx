import { stats, platforms, process, site } from "@/lib/site";
import { Container, Button, Arrow, Eyebrow } from "./ui";

export function StatBar({ dark = false }: { dark?: boolean }) {
  return (
    <div
      className={`grid grid-cols-2 gap-px overflow-hidden rounded-lg lg:grid-cols-3 ${
        dark ? "bg-white/10 ring-1 ring-white/10" : "bg-line ring-1 ring-line"
      }`}
    >
      {stats.map((s) => (
        <div
          key={s.label}
          className={`flex flex-col gap-1.5 p-6 ${dark ? "bg-navy" : "bg-white"}`}
        >
          <div
            className={`font-label text-2xl font-semibold sm:text-3xl ${
              dark ? "text-cream" : "text-crimson"
            }`}
          >
            {s.value}
          </div>
          <div
            className={`text-sm leading-snug ${
              dark ? "text-cream/55" : "text-muted"
            }`}
          >
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
}

export function LogoWall() {
  return (
    <div className="border-y border-line bg-paper-soft">
      <Container className="py-12">
        <p className="text-center text-xs font-semibold uppercase tracking-[0.18em] text-muted-soft">
          Forged inside PE-backed and founder-led companies
        </p>
        <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
          {platforms.map((p) => (
            <div
              key={p.name}
              className="flex flex-col items-center justify-center text-center"
            >
              <span className="text-[15px] font-bold tracking-tight text-ink/80">
                {p.name}
              </span>
              <span className="mt-1 text-[11px] font-medium uppercase tracking-wide text-muted-soft">
                {p.note}
              </span>
            </div>
          ))}
        </div>
      </Container>
    </div>
  );
}

export function ProcessSteps() {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {process.map((p, i) => (
        <div key={p.step} className="relative">
          <div className="flex items-center gap-3">
            <span className="text-gradient text-4xl font-bold tracking-tight">
              {p.step}
            </span>
            {i < process.length - 1 ? (
              <span className="hidden h-px flex-1 bg-gradient-to-r from-line to-transparent md:block" />
            ) : null}
          </div>
          <h3 className="mt-4 text-lg font-semibold text-ink">{p.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">{p.body}</p>
        </div>
      ))}
    </div>
  );
}

export function CtaBand() {
  return (
    <section className="relative overflow-hidden bg-ink">
      <div className="absolute inset-0 grid-texture opacity-60" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-400/50 to-transparent" />
      <div className="glow absolute inset-x-0 -top-20 h-64" />
      <Container className="relative py-20 text-center">
        <Eyebrow>Let&apos;s talk numbers</Eyebrow>
        <h2 className="mx-auto mt-5 max-w-2xl text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Your business is bigger than your finance function. Let&apos;s fix
          that.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-white/70">
          A 30-minute conversation about where you are, where you&apos;re going,
          and whether the numbers are ready to take you there.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/contact" variant="primary">
            Book a consultation <Arrow />
          </Button>
          <Button href="/results" variant="light">
            See the results
          </Button>
        </div>
        <p className="mt-6 text-sm text-white/40">
          Or reach me directly at{" "}
          <a
            href={site.founder.phoneHref}
            className="font-medium text-white/70 underline-offset-4 hover:underline"
          >
            {site.founder.phone}
          </a>
        </p>
      </Container>
    </section>
  );
}
