import Link from "next/link";
import type { ReactNode } from "react";
import type { StatusTone } from "@/lib/engagements/portal-model";

// Shared chrome for the portal home sections. Server components only — no
// hooks, no client JS — and every class name is a static string or comes from a
// static map, so Tailwind v4 can see it.

export function HomeSection({
  id,
  eyebrow,
  aside,
  children,
}: {
  id: string;
  eyebrow: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="text-sm font-semibold uppercase tracking-wide text-muted-soft">
          {eyebrow}
        </h2>
        {aside ? <div className="flex items-baseline gap-3">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A slim, calm empty state for one slot (EmptyState's py-16 is too tall for a strip). */
export function SoftNote({
  title,
  body,
  detail,
  action,
}: {
  title: string;
  body: string;
  detail?: ReactNode;
  action?: { href: string; label: string } | null;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-5">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{body}</p>
      {detail ? <div className="mt-1 space-y-0.5 text-xs text-muted-soft">{detail}</div> : null}
      {action ? (
        <Link
          href={action.href}
          className="mt-3 inline-block text-xs font-semibold text-brand-700 hover:underline"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

const TONE: Record<StatusTone, string> = {
  live: "bg-emerald-50 text-emerald-700",
  upcoming: "bg-brand-50 text-brand-700",
  paused: "bg-amber-50 text-amber-900",
  neutral: "bg-paper-soft text-muted",
  alert: "bg-red-50 text-red-700",
};

export function Pill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE[tone]}`}>
      {children}
    </span>
  );
}

/** A muted, staff-only line. Callers render it only for platform admins. */
export function StaffNote({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-muted-soft">{children}</p>;
}
