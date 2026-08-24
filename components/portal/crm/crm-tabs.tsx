"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Dashboard", href: "/portal/crm", adminOnly: false },
  { label: "Conversations", href: "/portal/crm/conversations", adminOnly: false },
  { label: "Contacts", href: "/portal/crm/contacts", adminOnly: false },
  { label: "Companies", href: "/portal/crm/companies", adminOnly: false },
  { label: "Deals", href: "/portal/crm/deals", adminOnly: false },
  { label: "Tasks", href: "/portal/crm/tasks", adminOnly: false },
  { label: "Cases", href: "/portal/crm/cases", adminOnly: false },
  { label: "Campaigns", href: "/portal/crm/campaigns", adminOnly: false },
  // Integration credentials (Twilio/CallRail) are admin-only.
  { label: "Settings", href: "/portal/crm/settings", adminOnly: true },
];

export function CrmTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/portal/crm" ? pathname === "/portal/crm" : pathname.startsWith(href);

  return (
    <nav className="mt-6 flex flex-wrap gap-1 border-b border-line">
      {TABS.filter((t) => isAdmin || !t.adminOnly).map((t) => (
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
