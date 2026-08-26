import type { Metadata } from "next";
import Link from "next/link";
import { Container, Eyebrow } from "@/components/ui";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "SMS Terms & Opt-In",
  description:
    "Terms and consent for the Growth by the Numbers text-message program: opt-in, message frequency, rates, STOP/HELP, and privacy.",
};

const UPDATED = "August 26, 2026";

function Clause({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export default function SmsTermsPage() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-80" />
        <Container className="relative py-16 sm:py-20">
          <Eyebrow>Legal</Eyebrow>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
            SMS Terms &amp; Opt-In
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/70">
            The terms that govern text messages from {site.name} (a service of {site.legalName}), and
            how you give and withdraw consent to receive them.
          </p>
          <p className="mt-6 text-sm text-white/50">Last updated: {UPDATED}</p>
        </Container>
      </section>

      {/* ── Body ── */}
      <Container className="py-16 sm:py-20">
        <div className="mx-auto max-w-3xl space-y-12">
          {/* Consent summary — the disclosure carriers and Twilio look for */}
          <div className="rounded-2xl border border-brand-300 bg-brand-50/60 p-6 text-[15px] leading-relaxed text-ink/85">
            <p>
              By providing your mobile phone number to {site.name} and agreeing to receive text
              messages, you consent to receive SMS messages from us at the number provided, including
              messages sent by an automated system. Consent is{" "}
              <span className="font-semibold text-ink">not a condition of purchase</span>. Message
              frequency varies. <span className="font-semibold text-ink">Message and data rates may
              apply.</span> Reply <span className="font-semibold text-ink">STOP</span> to cancel or{" "}
              <span className="font-semibold text-ink">HELP</span> for help.
            </p>
          </div>

          <Clause title="Program description">
            <p>
              {site.name} sends text messages related to your inquiry or engagement with us. Depending
              on how you interact with us, these may include scheduling and appointment messages,
              account and service notifications, replies to your questions, and follow-up about the
              services you requested. We do not send third-party marketing by text.
            </p>
          </Clause>

          <Clause title="How to opt in">
            <p>
              You opt in to receive text messages by providing your mobile number and agreeing to
              receive texts — for example by submitting it on a form that includes SMS consent, by
              giving it to us in writing, or by texting us first. When you opt in, we may send a
              confirmation message.
            </p>
          </Clause>

          <Clause title="Message frequency & rates">
            <p>
              Message frequency varies based on your interaction with us. Message and data rates may
              apply, depending on your mobile carrier and plan. {site.name} does not charge for the
              messages, but your carrier&apos;s standard rates still apply.
            </p>
          </Clause>

          <Clause title="Opt out — STOP">
            <p>
              You can cancel at any time by replying{" "}
              <span className="font-semibold text-ink">STOP</span> to any message. After you send STOP,
              we will send a one-time confirmation and will not send further texts unless you opt in
              again. You may also contact us at {site.founder.email} to be removed.
            </p>
          </Clause>

          <Clause title="Help — HELP">
            <p>
              For help, reply <span className="font-semibold text-ink">HELP</span> to any message, or
              contact us at{" "}
              <a href={`mailto:${site.founder.email}`} className="text-brand-700 underline">
                {site.founder.email}
              </a>{" "}
              or{" "}
              <a href={site.founder.phoneHref} className="text-brand-700 underline">
                {site.founder.phone}
              </a>
              .
            </p>
          </Clause>

          <Clause title="Carriers & delivery">
            <p>
              Carriers are not liable for delayed or undelivered messages. Delivery depends on your
              carrier and device and is not guaranteed.
            </p>
          </Clause>

          <Clause title="Privacy">
            <p>
              Your mobile number and opt-in are handled as described in our{" "}
              <Link href="/privacy" className="font-medium text-brand-700 underline">
                Privacy Policy
              </Link>
              . No mobile information — including your phone number and SMS opt-in — is shared with,
              sold to, or rented to third parties or affiliates for marketing or promotional purposes.
              Text-messaging originator opt-in data and consent are never shared with any third
              parties. We share your number only with the messaging providers that deliver these texts
              on our behalf, and only for that purpose.
            </p>
          </Clause>
        </div>
      </Container>
    </>
  );
}
