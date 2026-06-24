"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Fires a lightweight page-view ping on each portal navigation. Deduped by
// pathname so re-renders don't double-count.
export function ActivityTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const last = useRef<string>("");

  useEffect(() => {
    if (!pathname.startsWith("/portal")) return;
    if (last.current === pathname) return;
    last.current = pathname;

    const clientId = searchParams.get("client") ?? "";
    fetch("/api/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pathname, clientId }),
      keepalive: true,
    }).catch(() => {});
  }, [pathname, searchParams]);

  return null;
}
