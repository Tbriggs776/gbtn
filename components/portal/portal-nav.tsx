"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { Client } from "@/lib/types";
import { canSeeNav, type ClientRole, type NavKey } from "@/lib/permissions";
import { ClientSwitcher } from "./client-switcher";

type NavItem = { label: string; href: string; icon: keyof typeof icons; key: NavKey };

const icons = {
  overview: "M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z",
  documents:
    "M7 3h7l5 5v13a0 0 0 0 1 0 0H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm7 1.5V8h3.5",
  financials: "M4 19V5m0 14h16M8 15l3-4 3 2 4-6",
  fpa: "M4 20h16M6 20V10M10 20V4M14 20v-7M18 20V8",
  briefing: "M4 5h16M4 5v14a2 2 0 002 2h12a2 2 0 002-2V5M9 10l2 2 4-4",
  marketing: "M3 3v18h18M7 14l3-3 3 3 5-6",
  googleAds: "M10.5 3.5L3 16.5a3 3 0 005.2 3L15.7 6.5a3 3 0 00-5.2-3zM18 21a3 3 0 100-6 3 3 0 000 6z",
  conversations:
    "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
  levers: "M4 8h10M18 8h2M4 16h6M14 16h6M14 6v4M10 14v4",
  pricing: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  ops: "M8 2v3M16 2v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 12h2M9 16h2M14 12h2",
  crm: "M17 20h5v-2a4 4 0 0 0-3-3.87M9 20H4v-2a4 4 0 0 1 3-3.87m5-1.13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0",
  settings:
    "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  admin:
    "M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4z",
} as const;

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PortalNav({
  isAdmin,
  isStaff = false,
  clients,
  defaultClientId,
  userEmail,
  roles,
}: {
  isAdmin: boolean;
  /** GBTN staff (admin OR employee). Employees get a CRM-only sidebar. */
  isStaff?: boolean;
  clients: Client[];
  defaultClientId: string | null;
  userEmail: string;
  /** clientId -> this user's role there. Empty for platform admins. */
  roles: Record<string, ClientRole>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const activeClientId = searchParams.get("client") ?? defaultClientId;
  const activeClient = clients.find((c) => c.id === activeClientId);
  const role = activeClientId ? roles[activeClientId] ?? null : null;

  const all: NavItem[] = [
    { label: "Overview", href: "/portal", icon: "overview", key: "overview" },
    { label: "Documents", href: "/portal/documents", icon: "documents", key: "documents" },
    { label: "Financials", href: "/portal/financials", icon: "financials", key: "financials" },
    { label: "FP&A", href: "/portal/fpa", icon: "fpa", key: "fpa" },
    { label: "CFO Briefing", href: "/portal/briefing", icon: "briefing", key: "briefing" },
    { label: "Marketing", href: "/portal/marketing", icon: "marketing", key: "marketing" },
    { label: "Google Ads", href: "/portal/google-ads", icon: "googleAds", key: "googleAds" },
  ];
  // Client-specific tools.
  if (activeClient?.slug === "floor-daddy") {
    all.push({
      label: "Conversations",
      href: "/portal/conversations",
      icon: "conversations",
      key: "conversations",
    });
    all.push({ label: "Ops Reports", href: "/portal/ops-reports", icon: "ops", key: "opsReports" });
    all.push({ label: "Operational Levers", href: "/portal/operational-levers", icon: "levers", key: "levers" });
    all.push({ label: "Pricing", href: "/portal/pricing", icon: "pricing", key: "pricing" });
  }
  // CRM is GBTN's internal agency-sales tool — staff only (admins + employees).
  if (isStaff) {
    all.push({ label: "CRM", href: "/portal/crm", icon: "crm", key: "crm" });
  }
  all.push({ label: "Settings", href: "/portal/settings", icon: "settings", key: "settings" });
  all.push({ label: "Account", href: "/portal/account", icon: "account", key: "account" });
  all.push({ label: "Admin", href: "/portal/admin", icon: "admin", key: "admin" });

  // Employees (staff who aren't platform admins) have no client data — give them
  // a focused sidebar: CRM + Account only. Everyone else gets the capability
  // matrix, which must mirror exactly what the server honours or links would
  // bounce back to /portal.
  const isEmployee = isStaff && !isAdmin;
  const items = isEmployee
    ? all.filter((i) => i.key === "crm" || i.key === "account")
    : all.filter((i) => canSeeNav(i.key, role, isAdmin));

  const isActive = (href: string) =>
    href === "/portal" ? pathname === "/portal" : pathname.startsWith(href);

  const withClient = (href: string) =>
    activeClientId ? `${href}?client=${activeClientId}` : href;

  return (
    <>
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-line bg-white px-5 py-3 lg:hidden">
        <Link href="/portal" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-brand text-white">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
              <path d="M4 16.5l4.5-5 3.5 3.5L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M15 7h5v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="text-sm font-bold tracking-tight text-ink">GBTN Portal</span>
        </Link>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
          className="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
            <path d={open ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <aside
        className={`${
          open ? "block" : "hidden"
        } border-b border-line bg-white lg:block lg:border-b-0 lg:border-r lg:border-line`}
      >
        <div className="flex h-full flex-col gap-6 p-5 lg:w-64">
          {/* Brand (desktop) */}
          <Link href="/portal" className="hidden items-center gap-2.5 lg:flex">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-brand text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
                <path d="M4 16.5l4.5-5 3.5 3.5L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M15 7h5v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-[14px] font-bold tracking-tight text-ink">GBTN Portal</span>
              <span className="text-[11px] text-muted-soft">Growth by the Numbers</span>
            </span>
          </Link>

          {clients.length > 0 ? (
            <ClientSwitcher
              clients={clients}
              activeClientId={activeClientId}
              isAdmin={isAdmin}
            />
          ) : null}

          <nav className="flex flex-col gap-1">
            {items.map((item) => (
              <Link
                key={item.href}
                href={withClient(item.href)}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive(item.href)
                    ? "bg-ink text-white"
                    : "text-muted hover:bg-paper-soft hover:text-ink"
                }`}
              >
                <Icon d={icons[item.icon]} />
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="mt-auto border-t border-line pt-4">
            <p className="truncate px-3 text-xs text-muted-soft" title={userEmail}>
              {userEmail}
            </p>
            <form action="/auth/signout" method="post" className="mt-2">
              <button
                type="submit"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-paper-soft hover:text-ink"
              >
                <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14l5-5-5-5m5 5H9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}
