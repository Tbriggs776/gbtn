"use client";

import { useState } from "react";
import { site } from "@/lib/site";
import { Check } from "./ui";

export function ContactForm() {
  const [sent, setSent] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") || "");
    const company = String(data.get("company") || "");
    const revenue = String(data.get("revenue") || "");
    const message = String(data.get("message") || "");
    const email = String(data.get("email") || "");

    const subject = encodeURIComponent(
      `New inquiry from ${name || "the GBTN site"}`
    );
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\nCompany: ${company}\nRevenue stage: ${revenue}\n\n${message}`
    );
    // Opens the visitor's email client pre-filled. TODO: swap for a Formspree
    // (or similar) POST endpoint to capture leads server-side without mailto.
    window.location.href = `mailto:${site.founder.email}?subject=${subject}&body=${body}`;
    setSent(true);
  }

  const field =
    "w-full rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink placeholder:text-muted-soft focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
  const label = "mb-1.5 block text-sm font-medium text-ink";

  if (sent) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-brand-200 bg-brand-50/60 p-10 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-gradient-brand text-white">
          <Check className="text-white" />
        </div>
        <h3 className="mt-4 text-lg font-bold text-ink">
          Your email is ready to send.
        </h3>
        <p className="mt-2 max-w-sm text-sm text-muted">
          Your mail app should have opened with the details filled in. If it
          didn&apos;t, reach me directly at{" "}
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
    <form onSubmit={handleSubmit} className="grid gap-4">
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
          What&apos;s on your mind?
        </label>
        <textarea
          id="message"
          name="message"
          rows={5}
          required
          className={field}
          placeholder="Where you are, where you're trying to go, and what's getting in the way."
        />
      </div>
      <button
        type="submit"
        className="bg-gradient-brand mt-2 inline-flex items-center justify-center rounded-full px-6 py-3.5 text-sm font-semibold text-white ring-soft transition-all hover:-translate-y-0.5 hover:brightness-110"
      >
        Send message
      </button>
      <p className="text-xs text-muted-soft">
        Prefer to talk? Call {site.founder.phone} or connect on LinkedIn.
      </p>
    </form>
  );
}
