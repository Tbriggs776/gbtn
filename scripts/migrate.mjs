// Run a SQL migration against the Supabase Postgres database.
//
//   node scripts/migrate.mjs supabase/migrations/0003_financials.sql
//
// Reads a direct (non-pooling) connection string from, in order:
//   POSTGRES_URL_NON_POOLING, POSTGRES_URL, DATABASE_URL
// from .vercel/.env.production.local (preferred) or .env.local.

import { readFileSync } from "node:fs";
import pg from "pg";

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  } catch {
    /* ignore */
  }
  return env;
}

const env = {
  ...loadEnv(new URL("../.env.local", import.meta.url)),
  ...loadEnv(new URL("../.vercel/.env.production.local", import.meta.url)),
};

const conn =
  env.POSTGRES_URL_NON_POOLING || env.POSTGRES_URL || env.DATABASE_URL;
if (!conn) {
  console.error("✖ No Postgres connection string found in env files.");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("✖ Usage: node scripts/migrate.mjs <path-to.sql>");
  process.exit(1);
}

const sql = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const client = new pg.Client({
  connectionString: conn,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log(`→ Running ${file} ...`);
  await client.query(sql);
  console.log("✅ Migration applied successfully.");
} catch (e) {
  console.error("✖ Migration failed:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
