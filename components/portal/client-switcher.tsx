"use client";

import { usePathname, useRouter } from "next/navigation";
import type { Client } from "@/lib/types";

// For admins (who can access multiple clients) this is a dropdown that re-targets
// the current page at a different client via ?client=. For a single-client user
// it just shows the client name.
export function ClientSwitcher({
  clients,
  activeClientId,
  isAdmin,
}: {
  clients: Client[];
  activeClientId: string | null;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();

  if (!isAdmin || clients.length <= 1) {
    const active =
      clients.find((c) => c.id === activeClientId) ?? clients[0];
    return (
      <div className="rounded-xl border border-line bg-paper-soft px-3 py-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-soft">
          Client
        </p>
        <p className="truncate text-sm font-semibold text-ink">
          {active?.name ?? "None"}
        </p>
      </div>
    );
  }

  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted-soft">
        Viewing client
      </label>
      <select
        value={activeClientId ?? ""}
        onChange={(e) =>
          router.push(`${pathname}?client=${e.target.value}`)
        }
        className="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-sm font-medium text-ink focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
      >
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
