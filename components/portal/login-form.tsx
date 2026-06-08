"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    const supabase = createClient();
    const next = redirectTo && redirectTo.startsWith("/") ? redirectTo : "/portal";
    const emailRedirectTo = `${window.location.origin}/auth/confirm?next=${encodeURIComponent(
      next
    )}`;

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo, shouldCreateUser: false },
    });

    if (error) {
      setError(error.message);
      setStatus("error");
    } else {
      setStatus("sent");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-6 text-center">
        <p className="text-base font-semibold text-ink">Check your email</p>
        <p className="mt-2 text-sm text-muted">
          We sent a secure sign-in link to{" "}
          <span className="font-medium text-ink">{email}</span>. Click it to
          access your portal.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-ink"
        >
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
          className="w-full rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink placeholder:text-muted-soft focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-600">
          {error.includes("Signups not allowed")
            ? "That email isn't set up for access yet. Ask Tyler to send you an invite."
            : error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={status === "sending"}
        className="bg-gradient-brand inline-flex w-full items-center justify-center rounded-full px-6 py-3.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110 disabled:opacity-60"
      >
        {status === "sending" ? "Sending link…" : "Email me a sign-in link"}
      </button>
      <p className="text-center text-xs text-muted-soft">
        Access is invite-only. Use the email Tyler set you up with.
      </p>
    </form>
  );
}
