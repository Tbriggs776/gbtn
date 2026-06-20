"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { Client } from "@/lib/types";
import { ClientSwitcher } from "./client-switcher";

type NavItem = { label: string; href: string; icon: keyof typeof icons };

const icons = {
  overview: "M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z",
  documents:
    "M7 3h7l5 5v13a0 0 0 0 1 0 0H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm7 1.5V8h3.5",
  financials: "M4 19V5m0 14h16M8 15l3-4 3 2 4-6",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0",
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
  clients,
  defaultClientId,
  userEmail,
}: {
  isAdmin: boolean;
  clients: Client[];
  defaultClientId: string | null;
  userEmail: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const activeClientId = searchParams.get("client") ?? defaultClientId;

  const items: NavItem[] = [
    { label: "Overview", href: "/portal", icon: "overview" },
    { label: "Documents", href: "/portal/documents", icon: "documents" },
    { label: "Financials", href: "/portal/financials", icon: "financials" },
    { label: "Account", href: "/portal/account", icon: "account" },
  ];
  if (isAdmin) items.push({ label: "Admin", href: "/portal/admin", icon: "admin" });

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
