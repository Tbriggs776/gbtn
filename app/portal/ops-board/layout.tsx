import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Ops Board · GBTN",
  robots: { index: false, follow: false },
};

// Floor Daddy operating work is GBTN-internal. A client who opens the URL is
// sent back to their portal home before the page reads any cards.
export default async function OpsBoardLayout({ children }: { children: React.ReactNode }) {
  await requireStaff();
  return <>{children}</>;
}
