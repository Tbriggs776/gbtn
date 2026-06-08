import type { Metadata } from "next";
import Image from "next/image";
import {
  Container,
  Section,
  Button,
  Arrow,
  Check,
  Eyebrow,
  SectionHeading,
} from "@/components/ui";
import { CtaBand } from "@/components/sections";
import { trackRecord, site } from "@/lib/site";

export const metadata: Metadata = {
  title: "About Tyler Briggs",
  description:
    "Tyler Briggs is a fractional CFO and operator who scaled a PE-backed home-services platform from $30M to $100M+. Inside PE-backed and founder-led companies for 12+ years.",
};

const credentials = [
  "B.A. in Accounting, University of Phoenix",
  "QuickBooks ProAdvisor",
  "12+ years in PE-backed & founder-led operating companies",
  "President & CFO experience at $100M+ scale",
];

const systems = [
  "ServiceTitan",
  "NetSuite",
  "Sage Intacct",
  "Microsoft Dynamics / GP",
  "Power BI",
  "Tableau",
  "Yardi Voyager",
  "HouseCall Pro",
  "QuickBooks",
];

export default function AboutPage() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-80" />
        <Container className="relative py-20 sm:py-28">
          <div className="grid gap-12 lg:grid-cols-[1.3fr_1fr] lg:items-center">
            <div>
              <Eyebrow>About</Eyebrow>
              <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
                I&apos;ve sat in the seat I&apos;m asking you to trust me with.
              </h1>
              <p className="mt-6 text-lg leading-relaxed text-white/70">
                I&apos;m Tyler Briggs. For more than a decade I&apos;ve been the
                finance leader inside the kind of companies private equity
                builds: scaling revenue, integrating acquisitions, and
                answering to boards and sponsors. Growth by the Numbers is how I
                bring that operator experience to founders who can&apos;t yet
                justify a full-time CFO but can&apos;t afford to fly blind.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <Button href="/contact" variant="primary">
                  Work with me <Arrow />
                </Button>
                <Button href="/results" variant="light">
                  See the results
                </Button>
              </div>
            </div>

            {/* Headshot */}
            <div className="relative">
              <div className="relative aspect-[4/5] overflow-hidden rounded-3xl border border-white/10 ring-1 ring-white/10">
                <Image
                  src="/headshot-a.jpg"
                  alt="Tyler Briggs, Founder of Growth by the Numbers"
                  fill
                  priority
                  sizes="(max-width: 1024px) 100vw, 40vw"
                  className="object-cover object-top"
                />
              </div>
              <div className="absolute -bottom-5 -left-5 rounded-2xl border border-white/10 bg-ink-soft/90 px-5 py-4 backdrop-blur ring-1 ring-white/10">
                <p className="text-sm font-bold text-white">{site.founder.name}</p>
                <p className="text-xs text-white/50">{site.founder.title}</p>
              </div>
            </div>
          </div>
        </Container>
      </section>

      {/* ── Origin story ── */}
      <Section>
        <Container>
          <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-16">
            <SectionHeading
              eyebrow="The story"
              title="From the capital side of the table to the operator's chair."
            />
            <div className="space-y-5 text-lg leading-relaxed text-muted">
              <p>
                I started on the capital side: REIT accounting, fund
                structuring, and underwriting at a family office and as the
                founder of my own advisory practice. I learned how investors
                think about risk, return, and what actually makes a business
                worth buying.
              </p>
              <p>
                Then I crossed over to operations. At{" "}
                <span className="font-semibold text-ink">Panoramic Health</span>
                , an Audax-backed healthcare platform, I integrated acquisitions
                in a high-velocity roll-up. At{" "}
                <span className="font-semibold text-ink">
                  Semper Fi Heating &amp; Cooling
                </span>
                , a Pulte Capital-backed home-services company, I served as
                President &amp; CFO and helped scale the business from roughly
                $30M to over $100M in three years.
              </p>
              <p>
                That combination, investor discipline and operator scar tissue,
                is rare. Most fractional CFOs have done one or the other. I
                built Growth by the Numbers to give growing companies access to
                both, without the seven-figure cost of hiring it full-time.
              </p>
            </div>
          </div>
        </Container>
      </Section>

      {/* ── Track record timeline ── */}
      <Section className="bg-paper-soft">
        <Container>
          <SectionHeading
            eyebrow="Track record"
            title="The companies that shaped the playbook."
            intro="Across my career I've led more than $1B in acquisitions and over $5B in exits. Each of these taught me something I now bring to your business, from PE-grade reporting to the post-close integration where deals are won or lost."
          />

          <div className="mt-14 space-y-5">
            {trackRecord.map((t) => (
              <div
                key={t.company}
                className="group rounded-2xl border border-line bg-white p-7 ring-soft transition-shadow hover:ring-card sm:p-8"
              >
                <div className="grid gap-6 sm:grid-cols-[1fr_2fr]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-bold tracking-tight text-ink">
                        {t.company}
                      </h3>
                    </div>
                    <p className="mt-1 text-sm font-medium text-muted">
                      {t.role}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-soft">{t.period}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                        {t.backer}
                      </span>
                      <span className="rounded-full bg-paper-tint px-2.5 py-1 text-xs font-semibold text-muted">
                        {t.sector}
                      </span>
                    </div>
                  </div>
                  <div>
                    <p className="text-base font-medium leading-relaxed text-ink">
                      {t.highlight}
                    </p>
                    <ul className="mt-4 space-y-2">
                      {t.points.map((p) => (
                        <li
                          key={p}
                          className="flex items-start gap-2.5 text-sm leading-relaxed text-muted"
                        >
                          <Check className="text-brand-500" />
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Exits note: placeholder for confirmed outcomes */}
          <div className="mt-8 rounded-2xl border border-dashed border-brand-300 bg-brand-50/50 p-6">
            <p className="text-sm leading-relaxed text-ink/80">
              <span className="font-semibold text-brand-700">
                On exits &amp; outcomes:
              </span>{" "}
              I&apos;ve led value-creation journeys built for liquidity, with
              more than $1B in acquisitions and over $5B in exits across my
              career. Specific transaction outcomes can be discussed under NDA
              in a conversation.{" "}
              {/* TODO: Tyler, confirm which engagements were realized exits
                  (acquirer, value, multiple, IPO) and we'll feature them here. */}
            </p>
          </div>
        </Container>
      </Section>

      {/* ── Credentials + systems ── */}
      <Section>
        <Container>
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
            <div>
              <SectionHeading eyebrow="Credentials" title="The foundation." />
              <ul className="mt-8 space-y-3">
                {credentials.map((c) => (
                  <li key={c} className="flex items-start gap-3 text-ink/85">
                    <Check className="text-brand-500" />
                    <span className="text-base">{c}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <SectionHeading
                eyebrow="Systems"
                title="Fluent in the stack that runs growing companies."
              />
              <div className="mt-8 flex flex-wrap gap-2.5">
                {systems.map((s) => (
                  <span
                    key={s}
                    className="rounded-full border border-line bg-white px-4 py-2 text-sm font-medium text-ink/80"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
