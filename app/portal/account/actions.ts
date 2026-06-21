"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { sendEmail, emailLayout } from "@/lib/email";

export type AccountState = { ok?: boolean; error?: string; message?: string };

const nameSchema = z.object({ fullName: z.string().min(1, "Enter your name.").max(120) });

export async function updateNameAction(
  _prev: AccountState,
  formData: FormData
): Promise<AccountState> {
  const session = await requireSession();
  const parsed = nameSchema.safeParse({ fullName: String(formData.get("fullName") ?? "").trim() });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid name." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ full_name: parsed.data.fullName })
    .eq("id", session.user.id);
  if (error) return { error: error.message };

  revalidatePath("/portal/account");
  revalidatePath("/portal");
  return { ok: true, message: "Name updated." };
}

const emailSchema = z.object({ email: z.string().trim().email("Enter a valid email.") });

export async function updateEmailAction(
  _prev: AccountState,
  formData: FormData
): Promise<AccountState> {
  const session = await requireSession();
  const parsed = emailSchema.safeParse({ email: String(formData.get("email") ?? "").trim() });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid email." };

  const newEmail = parsed.data.email.toLowerCase();
  if (newEmail === (session.user.email ?? "").toLowerCase())
    return { error: "That's already your sign-in email." };

  const supabase = await createClient();
  // Supabase emails a confirmation link (the "Change Email Address" template).
  // The address only switches after the user clicks it; the "Email changed"
  // notification fires on confirmation in /auth/confirm.
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) return { error: error.message };

  return {
    ok: true,
    message: `Confirmation sent to ${newEmail}. Click the link in that email to finish the change.`,
  };
}

const pwSchema = z
  .object({
    password: z.string().min(8, "Use at least 8 characters."),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    message: "Passwords don't match.",
    path: ["confirm"],
  });

export async function updatePasswordAction(
  _prev: AccountState,
  formData: FormData
): Promise<AccountState> {
  const session = await requireSession();
  const parsed = pwSchema.safeParse({
    password: String(formData.get("password") ?? ""),
    confirm: String(formData.get("confirm") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: error.message };

  // Security notification (best-effort): tell the user their password changed.
  const email = session.user.email;
  if (email) {
    const html = emailLayout({
      heading: "Your password was changed",
      bodyHtml: `The password on your Growth by the Numbers account (<strong style="color:#11294a">${email}</strong>) was just changed. If this was you, no action is needed.
        <div style="font-size:14px;line-height:1.6;color:#3a4252;background:#fbf8f2;border-left:3px solid #9e2335;border-radius:0 8px 8px 0;padding:14px 16px;margin:22px 0 0;"><strong style="color:#11294a;">Didn't make this change?</strong> Reset your password right away and contact us at tyler@tylermbriggs.com.</div>`,
    });
    await sendEmail({
      to: email,
      subject: "Your password was changed · Growth by the Numbers",
      html,
    });
  }

  return { ok: true, message: "Password updated." };
}
