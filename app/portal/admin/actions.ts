"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  requireAdmin,
  requireSession,
  assertManages,
  assertManagesUser,
  assertCanChangeCredentials,
  manageableClientIds,
} from "@/lib/auth";
import { isClientRole } from "@/lib/permissions";
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
  await requireSession();

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
  // A client admin may only create users into their own companies.
  try {
    await assertManages(clientId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }
  // Role for the new membership; defaults to the least-privileged useful seat.
  const newRole = String(formData.get("role") ?? "finance");
  if (!isClientRole(newRole)) return { error: "Pick a valid role." };
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
    await admin
      .from("memberships")
      .upsert({ user_id: userId, client_id: clientId, role: newRole });
  }

  revalidatePath("/portal/admin");
  return {
    ok: true,
    message: `Created ${email}. Share the password — they'll be prompted to change it after signing in.`,
  };
}

// Admin: create a GBTN staff account (admin or employee). No client membership —
// staff live in the CRM/internal tools, not a client workspace. Platform-admin
// only (granting staff access to the whole system must not be delegable).
const createStaffSchema = z.object({
  email: z.string().email("Enter a valid email."),
  fullName: z.string().max(120).optional(),
  role: z.enum(["admin", "employee"]),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export async function inviteStaffAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireAdmin();

  const parsed = createStaffSchema.safeParse({
    email: String(formData.get("email") ?? "").trim(),
    fullName: String(formData.get("fullName") ?? "").trim() || undefined,
    role: String(formData.get("role") ?? "employee"),
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { email, fullName, role, password } = parsed.data;
  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
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
    // handle_new_user() seeds the profile as 'client'; promote to the staff role.
    const { error: pErr } = await admin.from("profiles").update({ role }).eq("id", userId);
    if (pErr) return { error: pErr.message };
  }

  revalidatePath("/portal/admin");
  return {
    ok: true,
    message: `Created ${role} ${email}. Share the password — they'll be prompted to change it after signing in.`,
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
  await requireSession();

  const parsed = setClientsSchema.safeParse({
    userId: String(formData.get("userId") ?? ""),
    clientIds: formData.getAll("clientIds").map(String).filter(Boolean),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { userId, clientIds } = parsed.data;

  const scope = await manageableClientIds();
  if (scope !== "all" && scope.length === 0) return { error: "You don't manage any clients." };
  // The target user must already be someone this admin manages. Without this,
  // any uuid could be granted a membership — which then makes them "managed"
  // and unlocks the credential-change path below. New people come in through
  // inviteUserAction, which scopes the client instead.
  try {
    await assertManagesUser(userId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }
  // Roles arrive as role:<clientId> fields so one submit can set access AND
  // the seat type per company. Reject bad input rather than defaulting —
  // 'finance' carries the financials capability, so failing open here would
  // quietly hand out the most sensitive seat.
  const badRole: string[] = [];
  const roleFor = (clientId: string) => {
    const v = String(formData.get(`role:${clientId}`) ?? "");
    if (!isClientRole(v)) {
      badRole.push(clientId);
      return "ops" as const;
    }
    return v;
  };

  const admin = createAdminClient();

  // Only ever rewrite memberships INSIDE this admin's scope. The old code
  // deleted every membership the user had, so a client admin saving this form
  // would silently revoke their access at companies it can't even see.
  const targets = scope === "all" ? clientIds : clientIds.filter((id) => scope.includes(id));
  if (scope !== "all" && targets.length !== clientIds.length) {
    return { error: "You can only assign clients you manage." };
  }

  // Resolve every role BEFORE mutating: the delete below is destructive, so a
  // bad role must abort the whole submit rather than wipe access first.
  const resolved = targets.map((client_id) => ({
    user_id: userId,
    client_id,
    role: roleFor(client_id),
  }));
  if (badRole.length > 0) return { error: "Pick a valid role for every selected client." };

  const delQuery = admin.from("memberships").delete().eq("user_id", userId);
  const { error: delErr } = await (scope === "all" ? delQuery : delQuery.in("client_id", scope));
  if (delErr) return { error: delErr.message };

  if (resolved.length > 0) {
    const { error: insErr } = await admin.from("memberships").insert(resolved);
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
  role: z.enum(["admin", "employee", "client"]).optional(),
  password: z.string().min(8, "Password must be at least 8 characters.").optional(),
});

export async function updateUserAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireSession();

  const parsed = updateUserSchema.safeParse({
    userId: String(formData.get("userId") ?? ""),
    fullName: String(formData.get("fullName") ?? "").trim() || undefined,
    email: String(formData.get("email") ?? "").trim() || undefined,
    role: (String(formData.get("role") ?? "") || undefined) as
      | "admin"
      | "employee"
      | "client"
      | undefined,
    password: String(formData.get("password") ?? "") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { userId, fullName, email, role, password } = parsed.data;

  // `role` here is the PLATFORM role (GBTN staff vs client). Granting it would
  // hand someone every client in the system, so it stays platform-admin-only —
  // a client admin escalating their own users is the obvious attack.
  if (role !== undefined && !session.isAdmin) {
    return { error: "Only GBTN staff can change platform access." };
  }
  // Client admins may only edit people inside their companies…
  try {
    await assertManagesUser(userId);
    // …and email/password are the global auth account, so seizing them would
    // hand over every OTHER company that user belongs to. Stricter gate.
    if (email !== undefined || password !== undefined) {
      await assertCanChangeCredentials(userId);
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }

  // Don't let an admin demote themselves (avoid locking out the last admin).
  if (role && role !== "admin" && userId === session.user.id) {
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

// Client admins can reset passwords for their own people; deleting the auth
// account outright stays platform-admin-only (the user may belong to companies
// this admin has no visibility into — removing their membership is the
// client-admin equivalent, via setUserClientsAction).
export async function resetUserPasswordAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireSession();

  const parsed = resetSchema.safeParse({ email: String(formData.get("email") ?? "").trim() });
  if (!parsed.success) return { error: "Invalid email." };

  // This action keys off an EMAIL, so without a scope check a client admin
  // could trigger a reset for any account in the system.
  const scope = await manageableClientIds();
  if (scope !== "all") {
    const adminAuth = createAdminClient();
    const { data: list } = await adminAuth.auth.admin.listUsers({ perPage: 200 });
    const target = list?.users.find(
      (u) => (u.email ?? "").toLowerCase() === parsed.data.email.toLowerCase()
    );
    if (!target) return { error: "That user isn't in your companies." };
    try {
      // A reset link is a credential change — same stricter gate.
      await assertCanChangeCredentials(target.id);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Not authorized." };
    }
  }

  const supabase = await createClient();
  const origin = await getOrigin();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/portal/account`,
  });
  if (error) return { error: error.message };

  return { ok: true, message: `Reset link sent to ${parsed.data.email}.` };
}
