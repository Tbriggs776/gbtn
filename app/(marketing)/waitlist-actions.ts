"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendEmail,
  emailLayout,
  CONTACT_NOTIFY_TO,
  upsertResendContact,
  BOOK_WAITLIST_SEGMENT_ID,
} from "@/lib/email";
import { site } from "@/lib/site";

export type WaitlistState = { ok?: boolean; error?: string };

const SOURCES = ["book", "metrics"] as const;
type WaitlistSource = (typeof SOURCES)[number];

const schema = z.object({
  firstName: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  source: z.enum(SOURCES).default("book"),
});

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseSource(raw: unknown): WaitlistSource {
  const s = String(raw ?? "");
  return (SOURCES as readonly string[]).includes(s) ? (s as WaitlistSource) : "book";
}

export async function submitWaitlistAction(
  _prev: WaitlistState,
  formData: FormData
): Promise<WaitlistState> {
  if (String(formData.get("website") ?? "")) return { ok: true };

  const parsed = schema.safeParse({
    firstName: String(formData.get("firstName") ?? "").trim() || undefined,
    email: formData.get("email"),
    source: parseSource(formData.get("source")),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const d = parsed.data;
  const userAgent = (await headers()).get("user-agent")?.slice(0, 500) ?? null;
  const isMetrics = d.source === "metrics";

  let waitlistId: string | null = null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("waitlist")
      .upsert(
        {
          first_name: d.firstName ?? null,
          email: d.email,
          source: d.source,
          user_agent: userAgent,
        },
        { onConflict: "email", ignoreDuplicates: true }
      )
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    waitlistId = data?.id ?? null;
  } catch {
    return {
      error:
        "Something went wrong saving your spot. Please email me directly at " +
        CONTACT_NOTIFY_TO +
        ".",
    };
  }

  const contact = await upsertResendContact({
    email: d.email,
    firstName: d.firstName,
    segmentId: BOOK_WAITLIST_SEGMENT_ID,
  });
  if (!contact.ok) {
    console.error("[waitlist] Resend contact upsert failed:", contact.error);
  }

  const greeting = d.firstName ? `Hi ${esc(d.firstName)},` : "Hi,";
  const onePagerUrl = `${site.url}/metrics/print`;
  const confirmHtml = isMetrics
    ? emailLayout({
        heading: "Your 7 metrics one-pager",
        bodyHtml: `
      <p style="margin:0 0 12px">${greeting}</p>
      <p style="margin:0 0 12px">You're on the list. Open the one-pager and print it (or save as PDF from the browser). You're also on the book waitlist — same list, I'll email you when the book is ready. No spam, no drip sequence.</p>
      <p style="margin:0">If you meant to book a consult instead, reply to this email or use the contact page on growthbythenumbers.com.</p>`,
        ctaLabel: "Open the one-pager",
        ctaUrl: onePagerUrl,
        footnote: "Metrics lead magnet · also book waitlist · not a consultation request.",
      })
    : emailLayout({
        heading: "You're on the book waitlist",
        bodyHtml: `
      <p style="margin:0 0 12px">${greeting}</p>
      <p style="margin:0 0 12px">You're on the list for the book — not a consultation. I'll email you when it's ready. No spam, no drip sequence.</p>
      <p style="margin:0">If you meant to book a consult instead, reply to this email or use the contact page on growthbythenumbers.com.</p>`,
        footnote: "Book waitlist confirmation · not a consultation request.",
      });
  const confirmed = await sendEmail({
    to: d.email,
    subject: isMetrics
      ? "Your 7 metrics one-pager"
      : "You're on the book waitlist",
    html: confirmHtml,
  });
  if (!confirmed.ok) {
    console.error("[waitlist] subscriber confirmation failed:", confirmed.error);
  }

  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#9a958c;white-space:nowrap">${label}</td><td style="color:#11294a"><strong>${value}</strong></td></tr>`;
  const sourceLabel = isMetrics ? "Metrics one-pager" : "Book waitlist";
  const html = emailLayout({
    heading: isMetrics ? "New metrics lead magnet signup" : "New book waitlist signup",
    bodyHtml: `
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;">
        ${row("First name", esc(d.firstName ?? "—"))}
        ${row("Email", `<a href="mailto:${esc(d.email)}" style="color:#16335b">${esc(d.email)}</a>`)}
        ${row("Source", sourceLabel)}
      </table>`,
    footnote: "This is a waitlist signup, not a consultation request.",
  });

  const sent = await sendEmail({
    subject: `${sourceLabel}: ${d.email}`,
    html,
    replyTo: d.email,
  });

  if (sent.ok && waitlistId) {
    try {
      const admin = createAdminClient();
      await admin.from("waitlist").update({ notified: true }).eq("id", waitlistId);
    } catch {
      /* non-fatal */
    }
  } else if (!sent.ok) {
    console.error("[waitlist] notification email failed:", sent.error);
  }

  return { ok: true };
}
