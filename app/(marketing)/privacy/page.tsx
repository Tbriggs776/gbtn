import type { Metadata } from "next";
import Link from "next/link";
import { Container, Eyebrow } from "@/components/ui";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Growth by the Numbers collects, uses, and protects your information, including our SMS/text messaging practices and consent.",
};

const UPDATED = "August 26, 2026";

/** A section heading + body wrapper for the legal prose. */
function Clause({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28">
      <h2 className="text-xl font-bold tracking-tight text-ink sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-80" />
        <Container className="relative py-16 sm:py-20">
          <Eyebrow>Legal</Eyebrow>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Privacy Policy
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/70">
            This policy explains what {site.name} collects, why, how we use and protect it, and the
            choices you have — including how our text-message program works.
          </p>
          <p className="mt-6 text-sm text-white/50">Last updated: {UPDATED}</p>
        </Container>
      </section>

      {/* ── Body ── */}
      <Container className="py-16 sm:py-20">
        <div className="mx-auto max-w-3xl space-y-12">
          <div className="space-y-4 text-[15px] leading-relaxed text-muted">
            <p>
              {site.name} (&ldquo;{site.shortName}&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;, or
              &ldquo;our&rdquo;) provides fractional CFO, advisory, and financial-operations services,
              together with a secure client portal at{" "}
              <span className="font-medium text-ink">{site.domain}</span>. We respect your privacy and
              are committed to protecting the personal information you share with us. This policy
              applies to our website, our client portal, and our communications with you, including
              email and SMS/text messaging.
            </p>
          </div>

          <Clause id="information-we-collect" title="1. Information we collect">
            <p>We collect information in three ways:</p>
            <p>
              <span className="font-semibold text-ink">Information you give us.</span> Your name,
              business name, email address, phone number, and anything you include when you contact
              us, request a consultation, join a waitlist, or engage our services. For client
              engagements this may include financial and operational data you or your systems provide
              so we can perform the work.
            </p>
            <p>
              <span className="font-semibold text-ink">Information collected automatically.</span>{" "}
              Standard log and device data — IP address, browser type, pages visited, and referring
              links — gathered through cookies and similar technologies to keep the site secure and
              understand how it is used.
            </p>
            <p>
              <span className="font-semibold text-ink">Information from connected services.</span> When
              you authorize an integration (for example accounting, CRM, marketing, or telephony
              platforms) we access only the data needed to deliver the service you asked for, under the
              permissions you grant.
            </p>
          </Clause>

          <Clause id="how-we-use" title="2. How we use your information">
            <p>We use the information we collect to:</p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>Provide, operate, and improve our services and the client portal;</li>
              <li>Respond to your inquiries and communicate with you about your engagement;</li>
              <li>
                Send transactional and service messages by email and, where you have consented, by
                SMS;
              </li>
              <li>Maintain security, prevent fraud, and meet legal and accounting obligations;</li>
              <li>Analyze and improve our website and offerings.</li>
            </ul>
            <p>
              We do not sell your personal information, and we do not use it for advertising by third
              parties.
            </p>
          </Clause>

          <Clause id="sms" title="3. SMS / text messaging">
            <p>
              With your consent, {site.shortName} may send you text messages related to your inquiry
              or engagement — for example scheduling, account and service notifications, and follow-up
              about the services you requested. Our messaging practices:
            </p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>
                <span className="font-semibold text-ink">Consent.</span> You opt in by providing your
                mobile number and agreeing to receive texts (for example on a form, in writing, or by
                texting us first). Consent to receive texts is never a condition of purchasing any
                good or service.
              </li>
              <li>
                <span className="font-semibold text-ink">Message frequency</span> varies based on your
                interaction with us.
              </li>
              <li>
                <span className="font-semibold text-ink">Message and data rates may apply,</span>{" "}
                depending on your mobile carrier and plan.
              </li>
              <li>
                <span className="font-semibold text-ink">Opt out at any time</span> by replying{" "}
                <span className="font-semibold text-ink">STOP</span> to any message. You will receive a
                one-time confirmation and no further texts unless you opt in again.
              </li>
              <li>
                <span className="font-semibold text-ink">Help</span> is available by replying{" "}
                <span className="font-semibold text-ink">HELP</span> to any message, or by contacting
                us at {site.founder.email}.
              </li>
              <li>Carriers are not liable for delayed or undelivered messages.</li>
            </ul>
            <p className="rounded-xl border border-line bg-paper-soft px-4 py-3 text-ink/85">
              <span className="font-semibold text-ink">
                No mobile information — including your phone number and SMS opt-in — is shared with,
                sold to, or rented to third parties or affiliates for marketing or promotional
                purposes.
              </span>{" "}
              Text-messaging originator opt-in data and consent are never shared with any third
              parties. We share your number only with the messaging providers that help us deliver the
              texts you asked for (see &ldquo;Service providers&rdquo; below), and only for that
              purpose.
            </p>
            <p>
              Full messaging terms are on our{" "}
              <Link href="/sms" className="font-medium text-brand-700 underline">
                SMS Terms &amp; Opt-In
              </Link>{" "}
              page.
            </p>
          </Clause>

          <Clause id="service-providers" title="4. Service providers">
            <p>
              We use trusted third-party companies to run our business. They process data only on our
              instructions and only to provide their service to us — never for their own marketing.
              These include providers for website hosting, database and authentication, email
              delivery, telephony and SMS, customer-relationship management, analytics, and accounting.
              Each is bound by its own privacy and security obligations.
            </p>
          </Clause>

          <Clause id="cookies" title="5. Cookies & analytics">
            <p>
              Our website uses cookies and similar technologies to keep you signed in, remember your
              preferences, secure the site, and measure usage. You can control cookies through your
              browser settings; disabling them may affect how parts of the site work.
            </p>
          </Clause>

          <Clause id="retention" title="6. Data retention">
            <p>
              We keep personal information only as long as needed for the purposes described here, to
              provide our services, and to meet legal, tax, and accounting requirements. When it is no
              longer needed, we delete or de-identify it.
            </p>
          </Clause>

          <Clause id="security" title="7. Security">
            <p>
              We use administrative, technical, and physical safeguards — including encryption in
              transit, access controls, and least-privilege permissions — to protect your information.
              No method of transmission or storage is perfectly secure, but we work to protect your
              data and to promptly address any issue that arises.
            </p>
          </Clause>

          <Clause id="your-rights" title="8. Your choices & rights">
            <p>
              You may request access to, correction of, or deletion of your personal information, and
              you may opt out of marketing communications at any time. Depending on where you live
              (for example, California and other U.S. states), you may have additional rights over your
              personal information. To exercise any of these, contact us at {site.founder.email}. We do
              not sell personal information.
            </p>
          </Clause>

          <Clause id="children" title="9. Children's privacy">
            <p>
              Our services are intended for businesses and are not directed to children under 16. We do
              not knowingly collect personal information from children.
            </p>
          </Clause>

          <Clause id="changes" title="10. Changes to this policy">
            <p>
              We may update this policy from time to time. When we do, we will revise the &ldquo;Last
              updated&rdquo; date above, and material changes will be reflected on this page.
            </p>
          </Clause>

          <Clause id="contact" title="11. Contact us">
            <p>Questions about this policy or your information? Reach us at:</p>
            <div className="rounded-xl border border-line bg-white px-5 py-4 text-ink">
              <p className="font-semibold">{site.name}</p>
              <p className="mt-1 text-sm text-muted">{site.founder.location}</p>
              <p className="mt-2 text-sm">
                <a href={`mailto:${site.founder.email}`} className="text-brand-700 underline">
                  {site.founder.email}
                </a>
              </p>
              <p className="text-sm">
                <a href={site.founder.phoneHref} className="text-brand-700 underline">
                  {site.founder.phone}
                </a>
              </p>
            </div>
          </Clause>
        </div>
      </Container>
    </>
  );
}
