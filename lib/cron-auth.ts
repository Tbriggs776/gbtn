import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Shared bearer-auth for every cron route.
//
// A request is authorized if its `Authorization: Bearer <token>` matches EITHER
// of two secrets:
//   1. process.env.CRON_SECRET      — sent by Vercel Cron when that env var is
//      set. Kept so the platform scheduler keeps working if it's ever added.
//   2. app_config('cron_secret')    — a secret held in the database, sent by the
//      Supabase pg_cron scheduler that drives these routes. This is what keeps
//      the automation running WITHOUT the Vercel env var configured.
//
// Neither match ⇒ unauthorized. It never fails open: with no env secret AND no
// db secret, nothing can authenticate, exactly as before.
export async function authorizeCron(req: Request): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!bearer) return false;

  const envSecret = process.env.CRON_SECRET;
  if (envSecret && bearer === envSecret) return true;

  // Fall back to the DB-held secret. Read via the service role (RLS bypassed by
  // design); app_config has no policies, so nothing else can read it.
  const admin = createAdminClient();
  const { data } = await admin
    .from("app_config")
    .select("value")
    .eq("key", "cron_secret")
    .maybeSingle();
  const dbSecret = (data?.value as string | undefined) ?? "";
  return dbSecret !== "" && bearer === dbSecret;
}
