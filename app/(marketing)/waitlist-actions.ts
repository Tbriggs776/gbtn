"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, emailLayout, CONTACT_NOTIFY_TO } from "@/lib/email";

export type WaitlistState = { ok?: boolean; error?: string };

const schema = z.object({
  firstName: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
});

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function submitWaitlistAction(
  _prev: WaitlistState,
  formData: FormData
): Promise<WaitlistState> {
  if (String(formData.get("website") ?? "")) return { ok: true };

  const parsed = schema.safeParse({
    firstName: String(formData.get("firstName") ?? "").trim() || undefined,
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const d = parsed.data;
  const userAgent = (await headers()).get("user-agent")?.slice(0, 500) ?? null;

  let waitlistId: string | null = null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("waitlist")
      .upsert(
        {
          first_name: d.firstName ?? null,
          email: d.email,
          source: "book",
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

  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#9a958c;white-space:nowrap">${label}</td><td style="color:#11294a"><strong>${value}</strong></td></tr>`;
  const html = emailLayout({
    heading: "New book waitlist signup",
    bodyHtml: `
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;">
        ${row("First name", esc(d.firstName ?? "—"))}
        ${row("Email", `<a href="mailto:${esc(d.email)}" style="color:#16335b">${esc(d.email)}</a>`)}
        ${row("Source", "Book waitlist")}
      </table>`,
    footnote: "This is a waitlist signup, not a consultation request.",
  });

  const sent = await sendEmail({
    subject: `Book waitlist: ${d.email}`,
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
