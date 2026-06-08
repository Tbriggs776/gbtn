// One-time setup helper. Reads .env.local, uses the service-role key to:
//   1. ensure an admin auth user exists (email-confirmed)
//   2. set that profile's role = 'admin'
//   3. create a demo client + link the admin as a member
//   4. print a ready-to-click magic link so you can log in without waiting on email
//
// Run:  node scripts/seed.mjs
// Safe to re-run (idempotent).

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// --- minimal .env.local parser (Node doesn't auto-load it) ---
function loadEnv() {
  const env = {};
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].trim();
    }
  } catch {
    /* ignore */
  }
  return env;
}

const env = loadEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "tyler.briggs@outlook.com";
const ADMIN_NAME = "Tyler Briggs";
const DEMO_CLIENT = "Demo Co";

if (!URL_ || !SERVICE) {
  console.error(
    "\n✖ Missing SUPABASE_SERVICE_ROLE_KEY (or URL) in .env.local.\n" +
      "  Add your service_role key to .env.local and re-run.\n"
  );
  process.exit(1);
}

const admin = createClient(URL_, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findUserByEmail(email) {
  // Paginate through users (fine for a small project).
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 200) break;
  }
  return null;
}

async function main() {
  console.log(`\n→ Setting up admin: ${ADMIN_EMAIL}`);

  // 1. Ensure the user exists, email-confirmed.
  let user = await findUserByEmail(ADMIN_EMAIL);
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email: ADMIN_EMAIL,
      email_confirm: true,
      user_metadata: { full_name: ADMIN_NAME },
    });
    if (error) throw error;
    user = data.user;
    console.log("  ✓ created auth user");
  } else {
    console.log("  ✓ auth user already exists");
  }

  // 2. Profile → admin (the trigger creates the row; upsert to be safe).
  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ id: user.id, full_name: ADMIN_NAME, role: "admin" });
  if (pErr) throw pErr;
  console.log("  ✓ profile role = admin");

  // 3. Demo client + membership.
  let { data: client } = await admin
    .from("clients")
    .select("*")
    .eq("slug", "demo-co")
    .maybeSingle();
  if (!client) {
    const { data, error } = await admin
      .from("clients")
      .insert({ name: DEMO_CLIENT, slug: "demo-co" })
      .select()
      .single();
    if (error) throw error;
    client = data;
    console.log(`  ✓ created demo client "${DEMO_CLIENT}"`);
  } else {
    console.log(`  ✓ demo client "${DEMO_CLIENT}" already exists`);
  }
  await admin
    .from("memberships")
    .upsert({ user_id: user.id, client_id: client.id });
  console.log("  ✓ linked admin to demo client");

  // 4. Magic link for instant login (no email needed). We use the hashed_token
  //    and point it straight at our /auth/confirm handler (verifyOtp server-side),
  //    rather than the action_link's verify-endpoint flow which needs a PKCE
  //    verifier this browser doesn't have.
  const { data: link, error: lErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ADMIN_EMAIL,
    options: { redirectTo: `${SITE}/auth/confirm?next=/portal` },
  });
  if (lErr) throw lErr;

  const tokenHash = link.properties.hashed_token;
  const directLink = `${SITE}/auth/confirm?token_hash=${tokenHash}&type=magiclink&next=/portal`;

  console.log("\n✅ Setup complete.\n");
  console.log("Click this link to sign in as admin:\n");
  console.log("   " + directLink + "\n");
}

main().catch((e) => {
  console.error("\n✖ Seed failed:", e.message || e, "\n");
  process.exit(1);
});
