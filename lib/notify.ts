import "server-only";
import { createAdminClient } from "./supabase/admin";
import { sendEmail } from "./email";

// Server-only helpers for notifying a client's team by email. Uses the
// service-role client to resolve membership → auth.users emails (bypasses RLS).

export type Recipient = { email: string; name?: string | null };

export async function getClientRecipients(
  clientId: string,
  excludeUserId?: string
): Promise<Recipient[]> {
  const admin = createAdminClient();
  const { data: members } = await admin
    .from("memberships")
    .select("user_id")
    .eq("client_id", clientId);

  const ids = (members ?? [])
    .map((m) => m.user_id as string)
    .filter((id) => id && id !== excludeUserId);

  const recipients: Recipient[] = [];
  for (const id of ids) {
    const { data } = await admin.auth.admin.getUserById(id);
    const u = data?.user;
    if (u?.email) {
      recipients.push({
        email: u.email,
        name: (u.user_metadata?.full_name as string | undefined) ?? null,
      });
    }
  }
  return recipients;
}

// Emails every member of a client (optionally excluding the actor). Best-effort:
// returns how many were targeted vs actually accepted by the provider.
export async function notifyClientMembers(
  clientId: string,
  {
    subject,
    html,
    excludeUserId,
  }: { subject: string; html: string; excludeUserId?: string }
): Promise<{ recipients: number; sent: number }> {
  const recipients = await getClientRecipients(clientId, excludeUserId);
  let sent = 0;
  for (const r of recipients) {
    const res = await sendEmail({ to: r.email, subject, html });
    if (res.ok) sent++;
  }
  return { recipients: recipients.length, sent };
}
