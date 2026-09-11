// Seed a client record, contacts, engagement, phases, deliverables, contract
// documents and the onboarding checklist from a payload file.
// Requires migration 0029_client_engagements.sql.
//
//   node scripts/seed-client.mjs scripts/clients/<slug>.json             # dry run
//   node scripts/seed-client.mjs scripts/clients/<slug>.json --commit    # writes
//
// DRY RUN IS THE DEFAULT, on purpose. Several scripts in this directory are
// pre-approved in .claude/settings.local.json and run with no prompt, and this
// one writes to production. An accidental invocation must be a no-op.
//
// INSERT/UPDATE ONLY — this script never deletes. Every write is an upsert on
// a natural key (slug, client_id+full_name, client_id+name, engagement_id+
// sequence, phase_id+sequence, client_id+category+item, storage_path), so a
// rerun updates in place and cannot duplicate. Contrast with
// load-floor-daddy-*.mjs, which delete before inserting; do not copy this file
// from those.
//
// WHY THE DATA LIVES OUTSIDE THIS FILE: a payload carries the client's legal
// name, fee, term, notice provisions and named personnel. Engagement terms,
// pricing and personnel information are Client Confidential Information under
// the standard GBTN MSA (section 9.2), and section 10.5 bars naming the client
// publicly without written consent. THIS REPO IS PUBLIC. `scripts/clients/*.json`
// is gitignored for exactly that reason. Never inline a real client's values
// here, and never quote them into a commit message or a PR.
//
// Storage paths are `<client_id>/<folder>/<filename>` — NOT `clients/<slug>/...`.
// 0016's storage_object_client() casts the first path segment to uuid and every
// client-files policy gates on it; recordDocumentAction asserts the same prefix.
// A slug-first path breaks both.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE) {
  console.error("\n✖ Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local.\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const payloadPath = args.find((a) => !a.startsWith("--"));

if (!payloadPath) {
  console.error("\n✖ Usage: node scripts/seed-client.mjs <payload.json> [--commit]\n");
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(readFileSync(payloadPath, "utf8"));
} catch (e) {
  console.error(`\n✖ Could not read payload ${payloadPath}: ${e.message}\n`);
  process.exit(1);
}

const { client: CLIENT, contacts: CONTACTS = [], engagement: ENGAGEMENT,
        phases: PHASES = [], documents: DOCS, onboarding: ONBOARD } = payload;

if (!CLIENT?.slug) {
  console.error("\n✖ Payload has no client.slug — that is the upsert key.\n");
  process.exit(1);
}

// Flatten the onboarding categories into rows up front so the dry run can
// count them and a missing file is caught before any write.
const onboardRows = (ONBOARD?.categories ?? []).flatMap((c) =>
  c.items.map((item) => ({
    category: c.category,
    item,
    priority: c.priority,
    owner: c.owner ?? "client",
    requested_on: ONBOARD.requested_on ?? null,
  }))
);

const docFiles = DOCS?.files ?? [];
const totalDeliverables = PHASES.reduce((n, p) => n + (p.deliverables?.length ?? 0), 0);

// Read every document off disk BEFORE writing anything, so a missing or
// unreadable file fails the run instead of leaving a half-seeded client.
const docBuffers = new Map();
for (const d of docFiles) {
  const full = join(DOCS.source_dir, d.file);
  try {
    docBuffers.set(d.file, readFileSync(full));
  } catch (e) {
    console.error(`\n✖ Cannot read ${full}: ${e.message}\n`);
    process.exit(1);
  }
}

console.log(`\n${COMMIT ? "▶ COMMITTING to" : "◌ DRY RUN against"} ${SUPABASE_URL}`);
console.log(`  payload      ${basename(payloadPath)}`);
console.log(`  client       1  (${CLIENT.slug}, status=${CLIENT.status ?? "active"})`);
console.log(`  contacts     ${CONTACTS.length}`);
console.log(`  engagement   ${ENGAGEMENT ? `1  (${ENGAGEMENT.status})` : "0"}`);
console.log(`  phases       ${PHASES.length}`);
console.log(`  deliverables ${totalDeliverables}`);
console.log(`  documents    ${docFiles.length}  (${[...docBuffers.values()]
  .reduce((n, b) => n + b.length, 0)
  .toLocaleString()} bytes read OK)`);
console.log(`  onboarding   ${onboardRows.length}`);

if (!COMMIT) {
  console.log("\n  Nothing written. Re-run with --commit to apply.\n");
  process.exit(0);
}

const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

function die(label, error) {
  console.error(`\n✖ ${label}: ${error.message ?? error}`);
  process.exit(1);
}

// 1. Client — upsert on the unique slug.
const { data: client, error: cErr } = await db
  .from("clients")
  .upsert(CLIENT, { onConflict: "slug" })
  .select("id, slug")
  .single();
if (cErr) die("clients upsert", cErr);
console.log(`\n✅ client ${client.slug} → ${client.id}`);

// 2. Contacts — upsert on (client_id, full_name).
if (CONTACTS.length) {
  const { data, error } = await db
    .from("client_contacts")
    .upsert(
      CONTACTS.map((c) => ({ ...c, client_id: client.id })),
      { onConflict: "client_id,full_name" }
    )
    .select("id");
  if (error) die("client_contacts upsert", error);
  console.log(`✅ contacts ${data.length}`);
}

// 3. Engagement — upsert on (client_id, name).
let engagementId = null;
if (ENGAGEMENT) {
  const { data, error } = await db
    .from("engagements")
    .upsert({ ...ENGAGEMENT, client_id: client.id }, { onConflict: "client_id,name" })
    .select("id, status")
    .single();
  if (error) die("engagements upsert", error);
  engagementId = data.id;
  console.log(`✅ engagement ${data.id} (${data.status})`);
}

// 4. Phases — upsert on (engagement_id, sequence).
const phaseIdBySeq = new Map();
if (engagementId && PHASES.length) {
  const { data, error } = await db
    .from("engagement_phases")
    .upsert(
      PHASES.map((p) => ({
        engagement_id: engagementId,
        sequence: p.sequence,
        name: p.name,
        purpose: p.purpose ?? null,
        starts_on: p.starts_on ?? null,
        ends_on: p.ends_on ?? null,
      })),
      { onConflict: "engagement_id,sequence" }
    )
    .select("id, sequence");
  if (error) die("engagement_phases upsert", error);
  for (const p of data) phaseIdBySeq.set(p.sequence, p.id);
  console.log(`✅ phases ${data.length}`);
}

// 5. Deliverables — upsert on (phase_id, sequence).
const delRows = PHASES.flatMap((p) =>
  (p.deliverables ?? []).map((name, i) => ({
    phase_id: phaseIdBySeq.get(p.sequence),
    sequence: i + 1,
    name,
  }))
).filter((r) => r.phase_id);

if (delRows.length) {
  const { data, error } = await db
    .from("engagement_deliverables")
    .upsert(delRows, { onConflict: "phase_id,sequence" })
    .select("id");
  if (error) die("engagement_deliverables upsert", error);
  console.log(`✅ deliverables ${data.length}`);
}

// 6. Documents — upload to the private bucket, then upsert the row.
// upsert:true on the object so a rerun replaces bytes rather than 409ing.
for (const d of docFiles) {
  const buf = docBuffers.get(d.file);
  const storagePath = `${client.id}/${d.folder}/${d.file}`;

  const { error: upErr } = await db.storage
    .from("client-files")
    .upload(storagePath, buf, {
      contentType: d.content_type ?? DOCX,
      upsert: true,
    });
  if (upErr) die(`storage upload ${d.file}`, upErr);

  const { error: rowErr } = await db.from("documents").upsert(
    {
      client_id: client.id,
      engagement_id: engagementId,
      storage_path: storagePath,
      file_name: d.file,
      byte_size: buf.length,
      content_type: d.content_type ?? DOCX,
      category: d.category,
      title: d.title,
      doc_type: d.doc_type,
      version: d.version ?? 1,
      status: d.status ?? "sent",
      effective_date: d.effective_date ?? null,
      visible_to_client: d.visible_to_client ?? true,
    },
    { onConflict: "storage_path" }
  );
  if (rowErr) die(`documents upsert ${d.file}`, rowErr);
  console.log(`✅ document ${d.doc_type.padEnd(10)} ${storagePath}`);
}

// 7. Onboarding checklist — upsert on (client_id, category, item).
if (onboardRows.length) {
  const { data, error } = await db
    .from("onboarding_items")
    .upsert(
      onboardRows.map((r) => ({ ...r, client_id: client.id, engagement_id: engagementId })),
      { onConflict: "client_id,category,item" }
    )
    .select("id");
  if (error) die("onboarding_items upsert", error);
  console.log(`✅ onboarding ${data.length}`);
}

console.log(`
Done. Not handled by this script:
  • memberships — nobody can see this client in the portal until a
    membership row exists for a real auth user
  • client_affiliates — seed only once the affiliate's legal name is confirmed
`);
