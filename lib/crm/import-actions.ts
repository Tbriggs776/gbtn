"use server";

import { revalidatePath } from "next/cache";
import { assertAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toE164 } from "./twilio";
import type { ActionResult } from "./types";

// Parse a small CSV (RFC-4180-ish: quoted fields, doubled quotes, commas/newlines
// inside quotes). Good enough for exported contact lists.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const HEADER_ALIASES: Record<string, string> = {
  "first name": "first_name",
  firstname: "first_name",
  first: "first_name",
  "last name": "last_name",
  lastname: "last_name",
  last: "last_name",
  email: "email",
  "email address": "email",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  company: "company",
  organization: "company",
  title: "title",
  "job title": "title",
  source: "source",
  notes: "notes",
};

export async function importContacts(
  csv: string
): Promise<ActionResult<{ imported: number; skipped: number; companies: number }>> {
  try {
    const session = await assertAdmin();
    const db = await createClient();
    const rows = parseCsv(csv);
    if (rows.length < 2) return { ok: false, error: "CSV needs a header row and at least one contact." };

    const header = rows[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? h.trim().toLowerCase());
    const idx = (name: string) => header.indexOf(name);
    const iEmail = idx("email");
    const iFirst = idx("first_name");
    const iLast = idx("last_name");
    const iPhone = idx("phone");
    const iCompany = idx("company");
    const iTitle = idx("title");
    const iSource = idx("source");
    const iNotes = idx("notes");

    // Resolve/create companies first.
    const companyNames = new Set<string>();
    for (const r of rows.slice(1)) {
      const name = iCompany >= 0 ? r[iCompany]?.trim() : "";
      if (name) companyNames.add(name);
    }
    const companyIdByName = new Map<string, string>();
    let companiesCreated = 0;
    for (const name of companyNames) {
      const { data: existing } = await db
        .from("crm_companies")
        .select("id")
        .ilike("name", name)
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        companyIdByName.set(name.toLowerCase(), existing.id as string);
      } else {
        const { data: created } = await db
          .from("crm_companies")
          .insert({ name, source: "import", owner: session.user.id })
          .select("id")
          .single();
        if (created?.id) {
          companyIdByName.set(name.toLowerCase(), created.id as string);
          companiesCreated++;
        }
      }
    }

    const contacts = rows.slice(1).map((r) => {
      const company = iCompany >= 0 ? r[iCompany]?.trim() : "";
      return {
        first_name: iFirst >= 0 ? r[iFirst]?.trim() || null : null,
        last_name: iLast >= 0 ? r[iLast]?.trim() || null : null,
        email: iEmail >= 0 ? r[iEmail]?.trim().toLowerCase() || null : null,
        phone: iPhone >= 0 ? toE164(r[iPhone]) ?? (r[iPhone]?.trim() || null) : null,
        title: iTitle >= 0 ? r[iTitle]?.trim() || null : null,
        company_id: company ? companyIdByName.get(company.toLowerCase()) ?? null : null,
        source: iSource >= 0 ? r[iSource]?.trim() || "import" : "import",
        notes: iNotes >= 0 ? r[iNotes]?.trim() || null : null,
        lifecycle_stage: "lead",
        owner: session.user.id,
      };
    });

    // Dedup by email against what's already stored (the unique index is a
    // partial expression index, so onConflict upsert can't target it). Rows
    // without an email always insert fresh.
    const emails = Array.from(
      new Set(contacts.map((c) => c.email).filter((e): e is string => Boolean(e)))
    );
    const existingEmails = new Set<string>();
    for (let i = 0; i < emails.length; i += 500) {
      const chunk = emails.slice(i, i + 500);
      const { data } = await db.from("crm_contacts").select("email").in("email", chunk);
      for (const r of data ?? []) if (r.email) existingEmails.add((r.email as string).toLowerCase());
    }

    const seen = new Set<string>();
    const toInsert = contacts.filter((c) => {
      if (!c.email) return true;
      if (existingEmails.has(c.email) || seen.has(c.email)) return false;
      seen.add(c.email);
      return true;
    });

    let imported = 0;
    for (let i = 0; i < toInsert.length; i += 500) {
      const chunk = toInsert.slice(i, i + 500);
      const { data, error } = await db.from("crm_contacts").insert(chunk).select("id");
      if (error) throw error;
      imported += (data ?? []).length;
    }

    revalidatePath("/portal/crm/contacts");
    return {
      ok: true,
      data: { imported, skipped: contacts.length - imported, companies: companiesCreated },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Import failed." };
  }
}
