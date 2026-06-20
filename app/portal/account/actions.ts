"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

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
  await requireSession();
  const parsed = pwSchema.safeParse({
    password: String(formData.get("password") ?? ""),
    confirm: String(formData.get("confirm") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: error.message };

  return { ok: true, message: "Password updated." };
}
