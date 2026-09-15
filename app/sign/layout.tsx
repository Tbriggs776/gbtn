import type { Metadata } from "next";
import { greatVibes } from "@/components/esign/signature-font";
import { site } from "@/lib/site";

// Public e-sign shell. Deliberately outside app/portal (no session, no portal
// nav, no activity tracker) and app/(marketing) (no site nav/footer), and not
// matched by middleware. The token in the path is the capability, so every page
// here is noindex and sends no Referer.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
  referrer: "no-referrer",
};

export default function SignLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`flex min-h-screen flex-col bg-paper-soft ${greatVibes.variable}`}>
      <header className="bg-ink">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <img
            src="/brand/lockup/lockup-horizontal-on-navy.png"
            alt={site.name}
            height={26}
            className="h-[26px] w-auto"
          />
          <span className="font-label text-[11px] uppercase tracking-[0.18em] text-cream/80">
            Secure document signing
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>

      <footer className="border-t border-line">
        <p className="mx-auto w-full max-w-3xl px-4 py-5 text-center text-xs text-muted sm:px-6">
          {site.name} is a dba of {site.legalName} · Questions?{" "}
          <a
            href={`mailto:${site.founder.email}`}
            className="font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            {site.founder.email}
          </a>
        </p>
      </footer>
    </div>
  );
}
