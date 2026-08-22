"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Dashboard", href: "/portal/crm" },
  { label: "Contacts", href: "/portal/crm/contacts" },
  { label: "Companies", href: "/portal/crm/companies" },
  { label: "Deals", href: "/portal/crm/deals" },
  { label: "Tasks", href: "/portal/crm/tasks" },
  { label: "Campaigns", href: "/portal/crm/campaigns" },
  { label: "Settings", href: "/portal/crm/settings" },
];

export function CrmNav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/portal/crm" ? pathname === "/portal/crm" : pathname.startsWith(href);

  return (
    <nav className="mt-6 flex flex-wrap gap-1 border-b border-line">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors ${
            isActive(t.href)
              ? "border-brand-700 text-ink"
              : "border-transparent text-muted hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
