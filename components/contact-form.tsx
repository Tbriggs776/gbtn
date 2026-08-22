"use client";

import { useActionState } from "react";
import { site } from "@/lib/site";
import { Check } from "./ui";
import { submitContactAction, type ContactState } from "@/app/(marketing)/contact/actions";

const initial: ContactState = {};

export function ContactForm() {
  const [state, action, pending] = useActionState(submitContactAction, initial);

  const field =
    "w-full rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink placeholder:text-muted-soft focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
  const label = "mb-1.5 block text-sm font-medium text-ink";

  if (state.ok) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-brand-200 bg-brand-50/60 p-10 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-gradient-brand text-white">
          <Check className="text-white" />
        </div>
        <h3 className="mt-4 text-lg font-bold text-ink">
          Request received — I’ll be in touch.
        </h3>
        <p className="mt-2 max-w-sm text-sm text-muted">
          I read every consult request personally and typically reply within one
          business day to set a 30-minute call. Need me sooner? Reach me at{" "}
          <a
            href={`mailto:${site.founder.email}`}
            className="font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            {site.founder.email}
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="grid gap-4">
      <div className="hidden" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className={label}>
            Name
          </label>
          <input id="name" name="name" required className={field} placeholder="Jane Owner" />
        </div>
        <div>
          <label htmlFor="email" className={label}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className={field}
            placeholder="jane@company.com"
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="company" className={label}>
            Company
          </label>
          <input id="company" name="company" className={field} placeholder="Company name" />
        </div>
        <div>
          <label htmlFor="revenue" className={label}>
            Revenue stage
          </label>
          <select id="revenue" name="revenue" className={field} defaultValue="">
            <option value="" disabled>
              Select one
            </option>
            <option>Under $5M</option>
            <option>$5M - $20M</option>
            <option>$20M - $50M</option>
            <option>$50M+</option>
            <option>PE-backed platform</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="message" className={label}>
          What should we cover on the call?
        </label>
        <textarea
          id="message"
          name="message"
          rows={5}
          required
          className={field}
          placeholder="Stage, the decision in front of you, and what you want out of a 30-minute consult."
        />
      </div>

      {state.error ? (
        <p className="text-sm text-red-600">{state.error}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="bg-gradient-brand mt-2 inline-flex items-center justify-center rounded-full px-6 py-3.5 text-sm font-semibold text-white ring-soft transition-all hover:-translate-y-0.5 hover:brightness-110 disabled:opacity-60 disabled:hover:translate-y-0"
      >
        {pending ? "Sending…" : "Request a consultation"}
      </button>
      <p className="text-xs text-muted-soft">
        This is for a consult, not the book waitlist. Prefer to talk now? Call{" "}
        {site.founder.phone}.
      </p>
    </form>
  );
}
