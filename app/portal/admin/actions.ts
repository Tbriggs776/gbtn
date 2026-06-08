"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionState = { ok?: boolean; error?: string; message?: string };

function slugify(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function getOrigin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return process.env.NEXT_PUBLIC_SITE_URL ?? `${proto}://${host}`;
}

const createClientSchema = z.object({
  name: z.string().min(2, "Enter a company name.").max(120),
});

export async function createClientAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  const parsed = createClientSchema.safeParse({
    name: String(formData.get("name") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const supabase = await createClient();
  const base = slugify(parsed.data.name) || "client";
  // Try base slug, then a short random suffix on collision.
  let slug = base;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await supabase
      .from("clients")
      .insert({ name: parsed.data.name, slug });
    if (!error) {
      revalidatePath("/portal/admin");
      revalidatePath("/portal");
      return { ok: true, message: `Created “${parsed.data.name}”.` };
    }
    if (error.code === "23505") {
      slug = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
      continue;
    }
    return { error: error.message };
  }
  return { error: "Could not generate a unique slug. Try a different name." };
}

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email."),
  clientId: z.string().uuid("Pick a client."),
  fullName: z.string().max(120).optional(),
});

export async function inviteUserAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  const parsed = inviteSchema.safeParse({
    email: String(formData.get("email") ?? "").trim(),
    clientId: String(formData.get("clientId") ?? ""),
    fullName: String(formData.get("fullName") ?? "").trim() || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { email, clientId, fullName } = parsed.data;
  const admin = createAdminClient();
  const origin = await getOrigin();

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/auth/confirm?next=/portal`,
    data: fullName ? { full_name: fullName } : undefined,
  });

  if (error) {
    if (/already been registered|already exists/i.test(error.message)) {
      return {
        error:
          "That email already has an account. (Linking existing users to a client is coming soon.)",
      };
    }
    return { error: error.message };
  }

  const userId = data.user?.id;
  if (userId) {
    await admin
      .from("memberships")
      .upsert({ user_id: userId, client_id: clientId });
    if (fullName) {
      await admin.from("profiles").update({ full_name: fullName }).eq("id", userId);
    }
  }

  revalidatePath("/portal/admin");
  return { ok: true, message: `Invite sent to ${email}.` };
}
