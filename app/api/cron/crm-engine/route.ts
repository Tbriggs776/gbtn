import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processDrips, processScheduledBlasts } from "@/lib/crm/campaign-engine";
import { sendEmail, emailLayout } from "@/lib/email";
import { appBaseUrl } from "@/lib/crm/comms";

// CRM background engine: advance drip sequences, fire scheduled blasts, and send
// due task reminders. Vercel Cron; protected by CRON_SECRET.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function sendTaskReminders(db: ReturnType<typeof createAdminClient>): Promise<number> {
  const now = new Date().toISOString();
  const { data: tasks } = await db
    .from("crm_tasks")
    .select("id, title, due_at, assignee, contact_id, remind_channel")
    .eq("status", "open")
    .not("reminder_at", "is", null)
    .lte("reminder_at", now)
    .is("reminded_at", null)
    .limit(100);

  let sent = 0;
  for (const t of tasks ?? []) {
    let email: string | null = null;
    if (t.assignee) {
      const { data } = await db.auth.admin.getUserById(t.assignee as string);
      email = data?.user?.email ?? null;
    }
    if (email) {
      const link = t.contact_id
        ? `${appBaseUrl()}/portal/crm/contacts/${t.contact_id}`
        : `${appBaseUrl()}/portal/crm/tasks`;
      const due = t.due_at ? new Date(t.due_at as string).toLocaleString("en-US") : "no due date";
      await sendEmail({
        to: email,
        subject: `Reminder: ${t.title}`,
        html: emailLayout({
          heading: "Task reminder",
          bodyHtml: `<p><strong>${t.title}</strong></p><p>Due: ${due}</p>`,
          ctaLabel: "Open in CRM",
          ctaUrl: link,
        }),
      });
    }
    await db.from("crm_tasks").update({ reminded_at: now }).eq("id", t.id);
    sent++;
  }
  return sent;
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const [drips, blasts, reminders] = await Promise.all([
    processDrips(db).catch((e) => ({ processed: -1, error: String(e) })),
    processScheduledBlasts(db).catch((e) => ({ fired: -1, error: String(e) })),
    sendTaskReminders(db).catch(() => -1),
  ]);

  return NextResponse.json({ ok: true, drips, blasts, reminders });
}
