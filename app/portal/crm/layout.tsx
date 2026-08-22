import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = {
  title: "CRM · GBTN",
  robots: { index: false, follow: false },
};

// The CRM is GBTN-internal — platform admins only. Gating the whole section here
// means every page and nested route inherits the guard.
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
