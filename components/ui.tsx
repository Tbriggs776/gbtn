import Link from "next/link";
import type { ReactNode } from "react";

export function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>
      {children}
    </div>
  );
}

export function Section({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`py-20 sm:py-28 ${className}`}>
      {children}
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="font-label inline-flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em] text-crimson">
      <span className="h-px w-8 bg-crimson" />
      {children}
    </span>
  );
}

export function Button({
  children,
  href,
  variant = "primary",
  className = "",
}: {
  children: ReactNode;
  href: string;
  variant?: "primary" | "secondary" | "ghost" | "light";
  className?: string;
}) {
  const base =
    "font-label inline-flex items-center justify-center gap-2 rounded-md px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-crimson focus-visible:ring-offset-2";
  const variants: Record<string, string> = {
    primary:
      "bg-gradient-brand text-cream ring-soft hover:brightness-110 hover:-translate-y-0.5",
    secondary:
      "bg-crimson text-cream hover:brightness-110 hover:-translate-y-0.5",
    ghost:
      "text-ink border border-stone hover:border-navy-2 hover:text-navy-2 bg-white",
    light:
      "bg-white/10 text-cream border border-white/20 backdrop-blur hover:bg-white/15",
  };
  return (
    <Link href={href} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </Link>
  );
}

export function Arrow({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 ${className}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Check({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-5 w-5 shrink-0 ${className}`}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="10" fill="currentColor" opacity="0.12" />
      <path
        d="M6 10.5l2.5 2.5L14 7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  intro,
  align = "left",
  dark = false,
}: {
  eyebrow?: string;
  title: ReactNode;
  intro?: ReactNode;
  align?: "left" | "center";
  dark?: boolean;
}) {
  return (
    <div
      className={`max-w-2xl ${align === "center" ? "mx-auto text-center" : ""}`}
    >
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2
        className={`mt-5 text-balance text-3xl font-semibold leading-[1.12] sm:text-[2.6rem] ${
          dark ? "text-cream" : "text-navy-2"
        }`}
      >
        {title}
      </h2>
      {intro ? (
        <p
          className={`mt-4 text-lg leading-relaxed ${
            dark ? "text-cream/70" : "text-muted"
          }`}
        >
          {intro}
        </p>
      ) : null}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-line bg-white p-7 ring-card ${className}`}
    >
      {children}
    </div>
  );
}
