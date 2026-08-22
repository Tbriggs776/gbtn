import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/portal/login-form";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = {
  title: "Team Login",
  description: "Sign in to the Growth by the Numbers team workspace.",
  robots: { index: false, follow: false },
};

// The GBTN staff door — admins and employees. Routes to the CRM after sign-in
// and rejects client accounts (strict). The client door is /login.
export default async function TeamLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const { redirect, error } = await searchParams;

  return (
    <div className="relative flex min-h-[calc(100vh-4rem)] items-center justify-center overflow-hidden bg-ink px-5 py-16">
      <div className="absolute inset-0 grid-texture opacity-40" />
      <div className="glow absolute inset-x-0 -top-24 h-72" />
      <div className="relative w-full max-w-md">
        <div className="rounded-3xl border border-white/10 bg-white p-8 ring-card sm:p-10">
          <div className="text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-gradient-brand text-white">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
                <path
                  d="M17 20h5v-2a4 4 0 0 0-3-3.87M9 20H4v-2a4 4 0 0 1 3-3.87m5-1.13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <h1 className="mt-5 text-2xl font-bold tracking-tight text-ink">Team Workspace</h1>
            <p className="mt-2 text-sm text-muted">
              GBTN staff sign-in for the CRM and internal tools.
            </p>
          </div>

          <div className="mt-8">
            {!isSupabaseConfigured ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-center">
                <p className="text-sm font-semibold text-amber-900">Not configured yet</p>
                <p className="mt-2 text-sm text-amber-800">
                  Supabase credentials haven&apos;t been added. See{" "}
                  <span className="font-mono">SETUP.md</span> to finish setup.
                </p>
              </div>
            ) : (
              <>
                {error === "auth" ? (
                  <p className="mb-4 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700">
                    That sign-in link was invalid or expired. Request a new one below.
                  </p>
                ) : null}
                <LoginForm redirectTo={redirect} audience="staff" />
              </>
            )}
          </div>
          <p className="mt-6 text-center text-xs text-muted-soft">
            Are you a client?{" "}
            <Link href="/login" className="font-semibold text-brand-700 hover:underline">
              Client login
            </Link>
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-white/50">
          <Link href="/" className="hover:text-white">
            ← Back to growthbythenumbers.com
          </Link>
        </p>
      </div>
    </div>
  );
}
