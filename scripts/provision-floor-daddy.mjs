// One-off: create the "Floor Daddy LLC" client and upload its GBTN deliverables
// into the portal Documents area. Run: node scripts/provision-floor-daddy.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#"))
        env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch {}
  return env;
}

const env = loadEnv(new URL("../.env.local", import.meta.url));
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const BUCKET = "client-files";
const CLIENT_NAME = "Floor Daddy LLC";
const CLIENT_SLUG = "floor-daddy";

const DOCS = [
  {
    src: "C:/Users/Tyler/Downloads/Floor_Daddy_May_2026_Findings_Brief.html",
    name: "May 2026 Findings Brief.html",
    category: "Financials",
  },
  {
    src: "C:/Users/Tyler/Downloads/Floor_Daddy_RFMS_Reporting_Playbook.html",
    name: "RFMS Reporting Playbook.html",
    category: "Reports",
  },
];

const safe = (s) => s.replace(/[^a-zA-Z0-9.\-_]+/g, "_").slice(0, 180);

async function main() {
  // 1. Find or create the client.
  let { data: client } = await admin
    .from("clients")
    .select("*")
    .eq("slug", CLIENT_SLUG)
    .maybeSingle();
  if (!client) {
    const { data, error } = await admin
      .from("clients")
      .insert({ name: CLIENT_NAME, slug: CLIENT_SLUG })
      .select()
      .single();
    if (error) throw error;
    client = data;
    console.log(`  ✓ created client "${CLIENT_NAME}" (${client.id})`);
  } else {
    console.log(`  ✓ client "${CLIENT_NAME}" already exists (${client.id})`);
  }

  // 2. uploaded_by = an admin (Tyler), for attribution.
  const { data: adminProfile } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  const uploadedBy = adminProfile?.id ?? null;

  // 3. Upload each report + record the documents row.
  for (const d of DOCS) {
    const buf = readFileSync(d.src);
    const path = `${client.id}/${crypto.randomUUID()}-${safe(d.name)}`;
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(path, buf, { contentType: "text/html", upsert: false });
    if (upErr) {
      console.error(`  ✖ upload failed for ${d.name}:`, upErr.message);
      continue;
    }
    const { error: rowErr } = await admin.from("documents").insert({
      client_id: client.id,
      uploaded_by: uploadedBy,
      storage_path: path,
      file_name: d.name,
      byte_size: buf.length,
      content_type: "text/html",
      category: d.category,
    });
    if (rowErr) {
      console.error(`  ✖ record failed for ${d.name}:`, rowErr.message);
      continue;
    }
    console.log(`  ✓ uploaded "${d.name}" (${d.category}, ${buf.length} bytes)`);
  }

  console.log("\n✅ Floor Daddy provisioned.");
}

main().catch((e) => {
  console.error("✖ Failed:", e.message || e);
  process.exit(1);
});
