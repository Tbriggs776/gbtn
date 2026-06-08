"use client";

import Link from "next/link";
import { useState } from "react";
import { nav, site } from "@/lib/site";
import { Button } from "./ui";

function Logo() {
  return (
    <Link href="/" className="group flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-brand text-white ring-soft">
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
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-bold tracking-tight text-ink">
          Growth by the Numbers
        </span>
        <span className="text-[11px] font-medium tracking-wide text-muted-soft">
          Fractional CFO &amp; Value Creation
        </span>
      </span>
    </Link>
  );
}

export function SiteNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-white/80 backdrop-blur-md">
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3.5 sm:px-8">
        <Logo />
        <div className="hidden items-center gap-8 md:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm font-medium text-muted transition-colors hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </div>
        <div className="hidden items-center gap-5 md:flex">
          <Link
            href="/login"
            className="text-sm font-medium text-muted transition-colors hover:text-ink"
          >
            Client Login
          </Link>
          <Button href="/contact" variant="primary">
            Book a consultation
          </Button>
        </div>
        <button
          type="button"
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
          className="grid h-10 w-10 place-items-center rounded-lg border border-line text-ink md:hidden"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
            <path
              d={open ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </nav>
      {open ? (
        <div className="border-t border-line bg-white md:hidden">
          <div className="space-y-1 px-5 py-4">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2.5 text-sm font-medium text-ink hover:bg-paper-soft"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2.5 text-sm font-medium text-ink hover:bg-paper-soft"
            >
              Client Login
            </Link>
            <Button href="/contact" variant="primary" className="mt-2 w-full">
              Book a consultation
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  );
}
