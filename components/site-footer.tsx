import Link from "next/link";
import { nav, site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-line bg-ink text-white">
      <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-brand text-white">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
                  <path
                    d="M4 16.5l4.5-5 3.5 3.5L20 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M15 7h5v5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="text-[15px] font-bold tracking-tight">
                Growth by the Numbers
              </span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/60">
              Operator-grade fractional CFO and value-creation partnership for
              founder-led and PE-backed businesses built to scale.
            </p>
            <p className="mt-6 text-sm text-white/50">
              {site.founder.location}
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">
              Explore
            </h3>
            <ul className="mt-4 space-y-2.5">
              {nav.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-white/70 transition-colors hover:text-white"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">
              Get in touch
            </h3>
            <ul className="mt-4 space-y-2.5">
              <li>
                <a
                  href={`mailto:${site.founder.email}`}
                  className="text-sm text-white/70 transition-colors hover:text-white"
                >
                  {site.founder.email}
                </a>
              </li>
              <li>
                <a
                  href={site.founder.phoneHref}
                  className="text-sm text-white/70 transition-colors hover:text-white"
                >
                  {site.founder.phone}
                </a>
              </li>
              <li>
                <a
                  href={site.founder.linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-white/70 transition-colors hover:text-white"
                >
                  LinkedIn
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-3 border-t border-white/10 pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-white/40">
            © {new Date().getFullYear()} {site.name}. All rights reserved.
          </p>
          <p className="text-xs text-white/40">
            Built for owners who run on the numbers.
          </p>
        </div>
      </div>
    </footer>
  );
}
