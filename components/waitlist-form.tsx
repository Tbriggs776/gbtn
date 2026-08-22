"use client";

import { useActionState } from "react";
import { Check } from "./ui";
import {
  submitWaitlistAction,
  type WaitlistState,
} from "@/app/(marketing)/waitlist-actions";

const initial: WaitlistState = {};

export function WaitlistForm() {
  const [state, action, pending] = useActionState(submitWaitlistAction, initial);

  const field =
    "w-full rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink placeholder:text-muted-soft focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
  const label = "mb-1.5 block text-sm font-medium text-ink";

  if (state.ok) {
    return (
      <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-6">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-brand text-white">
            <Check className="text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">You&apos;re on the list.</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              I&apos;ll email you when the book is ready. No spam, no drip sequence.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="mt-6 grid gap-3 sm:grid-cols-[1fr_1.3fr_auto] sm:items-end">
      <div className="hidden" aria-hidden="true">
        <label htmlFor="waitlist-website">Website</label>
        <input id="waitlist-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div>
        <label htmlFor="waitlist-first-name" className={label}>
          First name <span className="font-normal text-muted-soft">(optional)</span>
        </label>
        <input
          id="waitlist-first-name"
          name="firstName"
          autoComplete="given-name"
          className={field}
          placeholder="Tyler"
        />
      </div>
      <div>
        <label htmlFor="waitlist-email" className={label}>
          Email
        </label>
        <input
          id="waitlist-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className={field}
          placeholder="you@company.com"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="font-label inline-flex items-center justify-center rounded-md bg-crimson px-6 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-cream transition-all duration-200 hover:-translate-y-0.5 hover:brightness-110 disabled:opacity-60 disabled:hover:translate-y-0 sm:mb-px"
      >
        {pending ? "Saving…" : "Get on the list"}
      </button>

      {state.error ? (
        <p className="text-sm text-red-600 sm:col-span-3">{state.error}</p>
      ) : (
        <p className="text-xs text-muted-soft sm:col-span-3">
          Book waitlist only. For a consult, use{" "}
          <a href="/contact" className="font-medium text-brand-700 underline-offset-4 hover:underline">
            Book a consultation
          </a>
          .
        </p>
      )}
    </form>
  );
}
