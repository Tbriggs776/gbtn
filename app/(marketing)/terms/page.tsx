import type { Metadata } from "next";
import Link from "next/link";
import { Container, Eyebrow } from "@/components/ui";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms that govern your use of the Growth by the Numbers website, client portal, and services.",
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

export default function TermsPage() {
  return (
    <>
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-ink">
        <div className="absolute inset-0 grid-texture opacity-50" />
        <div className="glow absolute inset-x-0 -top-24 h-80" />
        <Container className="relative py-16 sm:py-20">
          <Eyebrow>Legal</Eyebrow>
          <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Terms of Service
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/70">
            These terms govern your use of the {site.name} website, client portal, and services.
            Please read them carefully.
          </p>
          <p className="mt-6 text-sm text-white/50">Last updated: {UPDATED}</p>
        </Container>
      </section>

      {/* ── Body ── */}
      <Container className="py-16 sm:py-20">
        <div className="mx-auto max-w-3xl space-y-12">
          <div className="space-y-4 text-[15px] leading-relaxed text-muted">
            <p>
              These Terms of Service (&ldquo;Terms&rdquo;) are a legal agreement between you and{" "}
              {site.legalName}, doing business as {site.name} (&ldquo;{site.shortName}&rdquo;,
              &ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;). By accessing or using our
              website at <span className="font-medium text-ink">{site.domain}</span>, our client
              portal, or any of our services, you agree to be bound by these Terms. If you do not
              agree, do not use our website or services.
            </p>
          </div>

          <Clause title="1. Our services">
            <p>
              {site.shortName} provides fractional CFO, financial-operations, advisory, and related
              services, along with software tools including a secure client portal. The specific scope,
              fees, and deliverables of any engagement are set out in a separate written agreement,
              statement of work, or proposal between you and us. Where those documents conflict with
              these Terms, the signed engagement documents control for that engagement.
            </p>
          </Clause>

          <Clause title="2. Eligibility & accounts">
            <p>
              Our services are intended for businesses and the individuals authorized to act on their
              behalf. You must be at least 18 years old. If we provide you with portal access, you are
              responsible for keeping your credentials confidential and for all activity under your
              account. Notify us promptly of any unauthorized use.
            </p>
          </Clause>

          <Clause title="3. Acceptable use">
            <p>You agree not to:</p>
            <ul className="ml-5 list-disc space-y-1.5">
              <li>Use the services for any unlawful, harmful, or fraudulent purpose;</li>
              <li>
                Access or attempt to access accounts, data, or systems you are not authorized to use;
              </li>
              <li>
                Interfere with or disrupt the integrity or performance of the website, portal, or
                services;
              </li>
              <li>
                Reverse engineer, copy, or resell any part of our software or services except as
                permitted by law or a written agreement.
              </li>
            </ul>
          </Clause>

          <Clause title="4. Your content & data">
            <p>
              You retain ownership of the data and materials you provide to us (&ldquo;Your
              Content&rdquo;). You grant us the limited right to use Your Content solely to provide and
              improve the services for you. You represent that you have the rights necessary to share
              Your Content with us. We handle personal information as described in our{" "}
              <Link href="/privacy" className="font-medium text-brand-700 underline">
                Privacy Policy
              </Link>
              .
            </p>
          </Clause>

          <Clause title="5. Intellectual property">
            <p>
              The website, portal, our software, methodologies, reports, templates, and all related
              content are owned by {site.legalName} or its licensors and are protected by intellectual
              property laws. Except for the rights expressly granted to you in a written agreement, we
              reserve all rights. You may not use our name, logo, or brand without our prior written
              consent.
            </p>
          </Clause>

          <Clause title="6. Fees & payment">
            <p>
              Fees for services are set out in your engagement documents. Unless stated otherwise,
              invoices are due on the terms specified there. Late or unpaid amounts may result in
              suspension of services. You are responsible for any applicable taxes other than taxes on
              our net income.
            </p>
          </Clause>

          <Clause title="7. Not legal, tax, or investment advice">
            <p>
              Our services and any materials we provide are for business and financial-operations
              purposes. Unless expressly agreed in writing, they do not constitute legal, tax, audit,
              or investment advice, and they are not a substitute for the advice of a licensed
              attorney, CPA, or registered investment adviser. You are responsible for your own
              business decisions.
            </p>
          </Clause>

          <Clause title="8. Text messaging">
            <p>
              If you opt in to receive text messages from us, our messaging program is governed by our{" "}
              <Link href="/sms" className="font-medium text-brand-700 underline">
                SMS Terms &amp; Opt-In
              </Link>
              . You can opt out at any time by replying{" "}
              <span className="font-semibold text-ink">STOP</span>, or get help by replying{" "}
              <span className="font-semibold text-ink">HELP</span>.
            </p>
          </Clause>

          <Clause title="9. Third-party services">
            <p>
              Our website and services may link to or integrate with third-party services. We are not
              responsible for the content, policies, or practices of those third parties, and your use
              of them is governed by their own terms.
            </p>
          </Clause>

          <Clause title="10. Disclaimers">
            <p>
              Except as expressly stated in a signed agreement, the website, portal, and services are
              provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo; without warranties of any
              kind, whether express or implied, including implied warranties of merchantability,
              fitness for a particular purpose, and non-infringement. We do not warrant that the
              services will be uninterrupted, error-free, or completely secure.
            </p>
          </Clause>

          <Clause title="11. Limitation of liability">
            <p>
              To the fullest extent permitted by law, {site.legalName} will not be liable for any
              indirect, incidental, special, consequential, or punitive damages, or any loss of
              profits, revenue, data, or goodwill, arising out of or related to your use of the website
              or services. Our total liability for any claim arising out of or relating to these Terms
              or the services will not exceed the amounts you paid us for the services giving rise to
              the claim in the twelve (12) months before the claim arose.
            </p>
          </Clause>

          <Clause title="12. Indemnification">
            <p>
              You agree to indemnify and hold harmless {site.legalName}, its officers, and its
              contractors from any claims, damages, liabilities, and expenses arising out of your
              misuse of the services, your violation of these Terms, or your violation of any law or
              the rights of a third party.
            </p>
          </Clause>

          <Clause title="13. Termination">
            <p>
              We may suspend or terminate your access to the website or portal at any time if you
              breach these Terms or if we reasonably believe your use poses a risk. Termination of any
              engagement is governed by your engagement documents. Provisions that by their nature
              should survive termination will survive.
            </p>
          </Clause>

          <Clause title="14. Governing law">
            <p>
              These Terms are governed by the laws of the State of Arizona, without regard to its
              conflict-of-laws rules. The state and federal courts located in Arizona will have
              exclusive jurisdiction over any dispute arising out of or relating to these Terms, and
              you consent to their jurisdiction and venue.
            </p>
          </Clause>

          <Clause title="15. Changes to these Terms">
            <p>
              We may update these Terms from time to time. When we do, we will revise the &ldquo;Last
              updated&rdquo; date above. Your continued use of the website or services after changes
              take effect constitutes acceptance of the revised Terms.
            </p>
          </Clause>

          <Clause title="16. Contact">
            <p>Questions about these Terms? Reach us at:</p>
            <div className="rounded-xl border border-line bg-white px-5 py-4 text-ink">
              <p className="font-semibold">
                {site.legalName} <span className="font-normal text-muted">dba {site.name}</span>
              </p>
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
