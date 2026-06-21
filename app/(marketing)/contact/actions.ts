"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, CONTACT_NOTIFY_TO } from "@/lib/email";

export type ContactState = { ok?: boolean; error?: string };

const schema = z.object({
  name: z.string().trim().min(1, "Please add your name.").max(120),
  email: z.string().trim().email("Enter a valid email."),
  company: z.string().trim().max(160).optional(),
  revenue: z.string().trim().max(60).optional(),
  message: z.string().trim().min(1, "Add a short message.").max(5000),
});

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function submitContactAction(
  _prev: ContactState,
  formData: FormData
): Promise<ContactState> {
  // Honeypot: real users never fill this hidden field. Pretend success.
  if (String(formData.get("website") ?? "")) return { ok: true };

  const parsed = schema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    company: formData.get("company") || undefined,
    revenue: formData.get("revenue") || undefined,
    message: formData.get("message"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const d = parsed.data;

  const userAgent = (await headers()).get("user-agent")?.slice(0, 500) ?? null;

  // 1. Persist first — the lead must survive even if email later fails.
  let submissionId: string | null = null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("contact_submissions")
      .insert({
        name: d.name,
        email: d.email,
        company: d.company ?? null,
        revenue_stage: d.revenue ?? null,
        message: d.message,
        user_agent: userAgent,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    submissionId = data?.id ?? null;
  } catch {
    return {
      error:
        "Something went wrong saving your message. Please email me directly at " +
        CONTACT_NOTIFY_TO + ".",
    };
  }

  // 2. Notify by email (best-effort). Record whether it sent.
  const html = `
    <div style="font-family:system-ui,sans-serif;font-size:15px;color:#11294a">
      <h2 style="margin:0 0 12px">New inquiry from the GBTN site</h2>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Name</td><td><strong>${esc(d.name)}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Email</td><td><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Company</td><td>${esc(d.company ?? "—")}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6b7280">Revenue stage</td><td>${esc(d.revenue ?? "—")}</td></tr>
      </table>
      <p style="margin:16px 0 6px;color:#6b7280">Message</p>
      <p style="margin:0;white-space:pre-wrap;border-left:3px solid #9e2335;padding-left:12px">${esc(d.message)}</p>
    </div>`;

  const sent = await sendEmail({
    subject: `New inquiry from ${d.name}`,
    html,
    replyTo: d.email,
  });

  if (sent.ok && submissionId) {
    try {
      const admin = createAdminClient();
      await admin
        .from("contact_submissions")
        .update({ notified: true })
        .eq("id", submissionId);
    } catch {
      /* non-fatal: the lead is stored regardless */
    }
  }

  // The submission is saved either way, so the visitor always sees success.
  return { ok: true };
}
