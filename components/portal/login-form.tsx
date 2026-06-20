"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Mode = "password" | "magic" | "reset";

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<Mode>("password");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<null | "magic" | "reset">(null);
  const [error, setError] = useState<string | null>(null);

  const next = redirectTo && redirectTo.startsWith("/") ? redirectTo : "/portal";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();

    if (mode === "password") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(
          /invalid login credentials/i.test(error.message)
            ? "Email or password is incorrect."
            : error.message
        );
        setBusy(false);
        return;
      }
      window.location.href = next; // full nav so the server picks up the cookie
      return;
    }

    if (mode === "magic") {
      const emailRedirectTo = `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}`;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo, shouldCreateUser: false },
      });
      setBusy(false);
      if (error)
        setError(
          error.message.includes("Signups not allowed")
            ? "That email isn't set up for access yet. Ask Tyler for an invite."
            : error.message
        );
      else setSent("magic");
      return;
    }

    // reset
    const redirect = `${window.location.origin}/auth/confirm?next=${encodeURIComponent("/portal/account")}`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirect });
    setBusy(false);
    if (error) setError(error.message);
    else setSent("reset");
  }

  const field =
    "w-full rounded-md border border-line bg-white px-4 py-3 text-sm text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100";
  const labelCls = "mb-1.5 block text-sm font-medium text-ink";

  if (sent) {
    return (
      <div className="rounded-md border border-brand-200 bg-brand-50/60 p-6 text-center">
        <p className="text-base font-semibold text-ink">Check your email</p>
        <p className="mt-2 text-sm text-muted">
          {sent === "reset"
            ? "We sent a password-reset link to "
            : "We sent a secure sign-in link to "}
          <span className="font-medium text-ink">{email}</span>. Open it in this
          browser to continue.
        </p>
      </div>
    );
  }

  const title =
    mode === "reset" ? "Reset your password" : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {title ? (
        <p className="text-sm text-muted">
          Enter your email and we&apos;ll send a link to set a new password.
        </p>
      ) : null}

      <div>
        <label htmlFor="email" className={labelCls}>
          Work email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className={field}
        />
      </div>

      {mode === "password" && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium text-ink">
              Password
            </label>
            <button
              type="button"
              onClick={() => {
                setMode("reset");
                setError(null);
              }}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              Forgot password?
            </button>
          </div>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className={field}
          />
        </div>
      )}

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={busy}
        className="font-label inline-flex w-full items-center justify-center rounded-md bg-gradient-brand px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:opacity-60"
      >
        {busy
          ? "Working…"
          : mode === "password"
            ? "Sign in"
            : mode === "magic"
              ? "Email me a sign-in link"
              : "Send reset link"}
      </button>

      <div className="text-center">
        {mode === "reset" ? (
          <button
            type="button"
            onClick={() => {
              setMode("password");
              setError(null);
            }}
            className="text-xs font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            Back to sign in
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === "password" ? "magic" : "password"));
              setError(null);
            }}
            className="text-xs font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            {mode === "password"
              ? "Email me a sign-in link instead"
              : "Sign in with a password instead"}
          </button>
        )}
      </div>

      <p className="text-center text-xs text-muted-soft">
        Access is invite-only. Use the credentials Tyler set you up with.
      </p>
    </form>
  );
}
