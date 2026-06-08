import type { Metadata } from "next";
import { Container, Eyebrow } from "@/components/ui";
import { ContactForm } from "@/components/contact-form";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Book a consultation with Tyler Briggs. A 30-minute conversation about your numbers, your goals, and whether Growth by the Numbers is the right fit.",
};

const contactItems = [
  {
    label: "Email",
    value: site.founder.email,
    href: `mailto:${site.founder.email}`,
  },
  { label: "Phone", value: site.founder.phone, href: site.founder.phoneHref },
  { label: "LinkedIn", value: "Connect with Tyler", href: site.founder.linkedin },
  { label: "Based in", value: site.founder.location, href: null },
];

export default function ContactPage() {
  return (
    <>
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-72" />
        <Container className="relative py-20 sm:py-24">
          <div className="mx-auto max-w-2xl text-center">
            <Eyebrow>Contact</Eyebrow>
            <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
              Let&apos;s talk numbers.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-white/70">
              Tell me where you are and where you&apos;re trying to go. If
              there&apos;s a fit, we&apos;ll set up a 30-minute call. If there
              isn&apos;t, I&apos;ll point you in a better direction.
            </p>
          </div>
        </Container>
      </section>

      <section className="py-16 sm:py-24">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
            {/* Contact details */}
            <div>
              <h2 className="text-xl font-bold tracking-tight text-ink">
                Reach me directly
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                You work with me, so you can reach me. No gatekeepers, no
                ticket queue.
              </p>
              <dl className="mt-8 space-y-5">
                {contactItems.map((c) => (
                  <div key={c.label}>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-muted-soft">
                      {c.label}
                    </dt>
                    <dd className="mt-1 text-base font-medium text-ink">
                      {c.href ? (
                        <a
                          href={c.href}
                          target={c.href.startsWith("http") ? "_blank" : undefined}
                          rel={
                            c.href.startsWith("http")
                              ? "noopener noreferrer"
                              : undefined
                          }
                          className="transition-colors hover:text-brand-700"
                        >
                          {c.value}
                        </a>
                      ) : (
                        c.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>

              {/* Calendly placeholder */}
              <div className="mt-10 rounded-2xl border border-dashed border-line bg-paper-soft p-5">
                <p className="text-sm text-muted">
                  {/* TODO: drop your Calendly/scheduling link into lib/site.ts
                      (founder.calendly) and we'll embed a "Pick a time" button here. */}
                  Prefer to self-schedule? A booking link can live right here.
                </p>
              </div>
            </div>

            {/* Form */}
            <div className="rounded-3xl border border-line bg-white p-7 ring-card sm:p-9">
              <ContactForm />
            </div>
          </div>
        </Container>
      </section>
    </>
  );
}
