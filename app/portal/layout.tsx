import type { Metadata } from "next";
import { Suspense } from "react";
import { requireSession, getAccessibleClients } from "@/lib/auth";
import { PortalNav } from "@/components/portal/portal-nav";
import { ActivityTracker } from "@/components/portal/activity-tracker";

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
  const mustChangePassword = Boolean(
    session.user.user_metadata?.must_change_password
  );

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
      <div className="min-w-0">
        {mustChangePassword ? (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-3 sm:px-8">
            <p className="text-sm text-amber-900">
              You&apos;re signed in with a temporary password.{" "}
              <a
                href="/portal/account"
                className="font-semibold underline underline-offset-2"
              >
                Set your own password
              </a>{" "}
              to secure your account.
            </p>
          </div>
        ) : null}
        {children}
      </div>
      <Suspense fallback={null}>
        <ActivityTracker />
      </Suspense>
    </div>
  );
}
