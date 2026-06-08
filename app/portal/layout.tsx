import type { Metadata } from "next";
import { Suspense } from "react";
import { requireSession, getAccessibleClients } from "@/lib/auth";
import { PortalNav } from "@/components/portal/portal-nav";

export const metadata: Metadata = {
  title: "Client Portal",
  robots: { index: false, follow: false },
};

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const clients = await getAccessibleClients();

  return (
    <div className="min-h-[calc(100vh-0px)] bg-paper-soft lg:grid lg:grid-cols-[16rem_1fr]">
      <Suspense fallback={<div className="lg:w-64" />}>
        <PortalNav
          isAdmin={session.isAdmin}
          clients={clients}
          defaultClientId={clients[0]?.id ?? null}
          userEmail={session.user.email ?? ""}
        />
      </Suspense>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
