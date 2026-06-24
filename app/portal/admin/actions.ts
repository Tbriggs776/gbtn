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

const createUserSchema = z.object({
  email: z.string().email("Enter a valid email."),
  clientId: z.string().uuid("Pick a client."),
  fullName: z.string().max(120).optional(),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

// Admin creates a user with a starter password. The user signs in with it and
// is prompted to change it (must_change_password flag, cleared on change).
export async function inviteUserAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  const parsed = createUserSchema.safeParse({
    email: String(formData.get("email") ?? "").trim(),
    clientId: String(formData.get("clientId") ?? ""),
    fullName: String(formData.get("fullName") ?? "").trim() || undefined,
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { email, clientId, fullName, password } = parsed.data;
  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no confirmation email; admin shares the password
    user_metadata: {
      ...(fullName ? { full_name: fullName } : {}),
      must_change_password: true,
    },
  });

  if (error) {
    if (/already.*(registered|exists)|exists/i.test(error.message)) {
      return { error: "That email already has an account." };
    }
    return { error: error.message };
  }

  const userId = data.user?.id;
  if (userId) {
    await admin.from("memberships").upsert({ user_id: userId, client_id: clientId });
  }

  revalidatePath("/portal/admin");
  return {
    ok: true,
    message: `Created ${email}. Share the password — they'll be prompted to change it after signing in.`,
  };
}

// Admin: replace a user's client memberships with the selected set (many-to-many).
const setClientsSchema = z.object({
  userId: z.string().uuid("Invalid user."),
  clientIds: z.array(z.string().uuid()),
});

export async function setUserClientsAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  const parsed = setClientsSchema.safeParse({
    userId: String(formData.get("userId") ?? ""),
    clientIds: formData.getAll("clientIds").map(String).filter(Boolean),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { userId, clientIds } = parsed.data;
  const admin = createAdminClient();

  // Replace the full set: clear, then insert the chosen clients.
  const { error: delErr } = await admin.from("memberships").delete().eq("user_id", userId);
  if (delErr) return { error: delErr.message };

  if (clientIds.length > 0) {
    const rows = clientIds.map((client_id) => ({ user_id: userId, client_id }));
    const { error: insErr } = await admin.from("memberships").insert(rows);
    if (insErr) return { error: insErr.message };
  }

  revalidatePath("/portal/admin");
  revalidatePath("/portal");
  return {
    ok: true,
    message: `Updated access — ${clientIds.length} client${clientIds.length === 1 ? "" : "s"}.`,
  };
}

// Admin: edit a user's name / email / role.
const updateUserSchema = z.object({
  userId: z.string().uuid("Invalid user."),
  fullName: z.string().trim().max(120).optional(),
  email: z.string().trim().email("Enter a valid email.").optional(),
  role: z.enum(["admin", "client"]).optional(),
  password: z.string().min(8, "Password must be at least 8 characters.").optional(),
});

export async function updateUserAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireAdmin();

  const parsed = updateUserSchema.safeParse({
    userId: String(formData.get("userId") ?? ""),
    fullName: String(formData.get("fullName") ?? "").trim() || undefined,
    email: String(formData.get("email") ?? "").trim() || undefined,
    role: (String(formData.get("role") ?? "") || undefined) as "admin" | "client" | undefined,
    password: String(formData.get("password") ?? "") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { userId, fullName, email, role, password } = parsed.data;

  // Don't let an admin demote themselves (avoid locking out the last admin).
  if (role === "client" && userId === session.user.id) {
    return { error: "You can't remove your own admin access." };
  }

  const admin = createAdminClient();

  // Auth: email + password + display-name metadata.
  const authUpdate: {
    email?: string;
    email_confirm?: boolean;
    password?: string;
    user_metadata?: { full_name?: string; must_change_password?: boolean };
  } = {};
  if (email) {
    authUpdate.email = email;
    authUpdate.email_confirm = true; // admin override, no re-confirmation needed
  }
  if (password) {
    authUpdate.password = password;
    // Admin set a new password → prompt the user to change it on next login.
    authUpdate.user_metadata = { ...authUpdate.user_metadata, must_change_password: true };
  }
  if (fullName !== undefined) {
    authUpdate.user_metadata = { ...authUpdate.user_metadata, full_name: fullName };
  }
  if (Object.keys(authUpdate).length > 0) {
    const { error } = await admin.auth.admin.updateUserById(userId, authUpdate);
    if (error) return { error: error.message };
  }

  // Profile: name + role.
  const profileUpdate: { full_name?: string; role?: string } = {};
  if (fullName !== undefined) profileUpdate.full_name = fullName;
  if (role) profileUpdate.role = role;
  if (Object.keys(profileUpdate).length > 0) {
    const { error } = await admin.from("profiles").update(profileUpdate).eq("id", userId);
    if (error) return { error: error.message };
  }

  revalidatePath("/portal/admin");
  revalidatePath("/portal");
  return { ok: true, message: "User updated." };
}

// Admin: permanently remove a user (auth + profile + memberships).
export async function deleteUserAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireAdmin();

  const userId = String(formData.get("userId") ?? "");
  if (!z.string().uuid().safeParse(userId).success) return { error: "Invalid user." };
  if (userId === session.user.id) return { error: "You can't remove your own account." };

  const admin = createAdminClient();
  await admin.from("memberships").delete().eq("user_id", userId);
  await admin.from("profiles").delete().eq("id", userId);
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return { error: error.message };

  revalidatePath("/portal/admin");
  revalidatePath("/portal");
  return { ok: true, message: "User removed." };
}

// Admin: email a password-reset link to a user (uses the configured SMTP +
// branded recovery template).
const resetSchema = z.object({ email: z.string().email() });

export async function resetUserPasswordAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  const parsed = resetSchema.safeParse({ email: String(formData.get("email") ?? "").trim() });
  if (!parsed.success) return { error: "Invalid email." };

  const supabase = await createClient();
  const origin = await getOrigin();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/portal/account`,
  });
  if (error) return { error: error.message };

  return { ok: true, message: `Reset link sent to ${parsed.data.email}.` };
}
