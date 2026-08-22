import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";

export const metadata: Metadata = {
  title: "CRM · GBTN",
  robots: { index: false, follow: false },
};

// The CRM is GBTN-internal — staff only (admins + employees). Gating the whole
// section here means every page and nested route inherits the guard; a client
// who reaches any /portal/crm URL is redirected to their portal home.
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  await requireStaff();
  return <>{children}</>;
}
