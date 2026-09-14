import "server-only";
import { sendEmail, emailLayout } from "@/lib/email";
import { sendSms } from "@/lib/crm/twilio";
import { site } from "@/lib/site";

// E-sign notifications. Email goes through lib/email.ts directly, not
// lib/crm/comms.ts: these are transactional legal notices to client contacts,
// not CRM messages (no unsubscribe footer, no crm_messages rows). The audit
// trail is signature_event, written by the engine from these results.
//
// emailLayout() interpolates heading, ctaLabel, ctaUrl and footnote unescaped,
// so every value handed to it is escaped here. Nothing here throws, and the
// OTP code never appears in a return value or a log.

const MAX_ATTACHMENT_BYTES = 15_000_000;

type NotifyResult = { ok: boolean; error?: string };

export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escaped, with the signer's line breaks kept. */
function escapeMultiline(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, "<br>");
}

/** Subjects are plain text; keep them on one line. */
function oneLine(s: string): string {
  return String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function arizonaTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    dateStyle: "long",
    timeStyle: "short",
  }).format(d);
  return `${formatted} Arizona time`;
}

function pdfAttachment(pdf: Uint8Array, fileName: string) {
  if (pdf.byteLength > MAX_ATTACHMENT_BYTES) return null;
  return {
    filename: fileName,
    content: Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString("base64"),
    content_type: "application/pdf",
  };
}

function normalizeName(s: string): string {
  return String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function row(label: string, valueHtml: string): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:#9a958c;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:4px 0;vertical-align:top;">${valueHtml}</td></tr>`;
}

function mono(s: string): string {
  return `<span style="font-family:Consolas,Menlo,monospace;font-size:12px;word-break:break-all;">${escapeHtml(s)}</span>`;
}

export async function sendSigningInvite(i: {
  to: string; signerName: string; title: string; clientName: string; signUrl: string; expiresAt: string;
}): Promise<NotifyResult> {
  try {
    const bodyHtml = [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(i.signerName)},</p>`,
      `<p style="margin:0 0 12px;">${escapeHtml(site.name)} (${escapeHtml(site.legalName)}) has sent you <strong>${escapeHtml(i.title)}</strong> for ${escapeHtml(i.clientName)} to review and sign electronically.</p>`,
      `<p style="margin:0 0 12px;">This link is personal to you. Please don't forward it: anyone with the link can open the signing page. It expires ${escapeHtml(arizonaTime(i.expiresAt))}.</p>`,
      `<p style="margin:0;">Questions? Just reply to this email.</p>`,
    ].join("");
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(`Please review and sign: ${i.title}`),
      html: emailLayout({
        heading: escapeHtml(`Please review and sign: ${i.title}`),
        bodyHtml,
        ctaLabel: escapeHtml("Review & sign"),
        ctaUrl: escapeHtml(i.signUrl),
        footnote: escapeHtml("If you weren't expecting this, you can ignore this email and the link will expire on its own."),
      }),
      replyTo: site.founder.email,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch {
    return { ok: false, error: "Invite email failed." };
  }
}

export async function sendSignedCopy(i: {
  to: string; signerName: string; title: string; signedAt: string; sealedSha256: string; pdf: Uint8Array; fileName: string;
}): Promise<NotifyResult> {
  try {
    const attachment = pdfAttachment(i.pdf, i.fileName);
    const copyLine = attachment
      ? "A sealed copy is attached. You can also download it from your signing link within 30 days."
      : "The signed PDF is too large to attach; download it from your signing link within 30 days, or reply to ask GBTN for a copy.";
    const bodyHtml = [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(i.signerName)},</p>`,
      `<p style="margin:0 0 12px;">Thank you for signing <strong>${escapeHtml(i.title)}</strong> on ${escapeHtml(arizonaTime(i.signedAt))}.</p>`,
      `<p style="margin:0 0 12px;">${escapeHtml(copyLine)}</p>`,
      `<p style="margin:0 0 4px;">SHA-256 of the sealed file, so any later change is detectable:</p>`,
      `<p style="margin:0;">${mono(i.sealedSha256)}</p>`,
    ].join("");
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(`Signed: ${i.title}`),
      html: emailLayout({
        heading: escapeHtml(`Signed: ${i.title}`),
        bodyHtml,
        footnote: escapeHtml("You can request a paper copy at any time, at no charge, by replying to this email."),
      }),
      replyTo: site.founder.email,
      ...(attachment ? { attachments: [attachment] } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch {
    return { ok: false, error: "Signed copy email failed." };
  }
}

export async function notifyStaffSigned(i: {
  to: string[]; title: string; clientName: string; signerName: string; printedName: string; signerEmail: string;
  signedAt: string; requestId: string; sealedSha256: string; engagementActivated: boolean; pdf: Uint8Array; fileName: string;
}): Promise<NotifyResult> {
  try {
    const attachment = pdfAttachment(i.pdf, i.fileName);
    const nameDiffers = normalizeName(i.printedName) !== normalizeName(i.signerName);
    const bodyHtml = [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(i.title)}</strong> for ${escapeHtml(i.clientName)} has been signed.</p>`,
      nameDiffers
        ? `<p style="margin:0 0 12px;color:#9e2335;"><strong>The printed name differs from the name the request was sent to. Review before relying on it.</strong></p>`
        : "",
      `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 12px;">`,
      row("Sent to", escapeHtml(i.signerName)),
      row("Printed name", escapeHtml(i.printedName)),
      row("Email", escapeHtml(i.signerEmail)),
      row("Signed", escapeHtml(arizonaTime(i.signedAt))),
      row("Engagement", escapeHtml(i.engagementActivated ? "Linked engagement is now active." : "No engagement change.")),
      row("Request", mono(i.requestId)),
      row("Sealed SHA-256", mono(i.sealedSha256)),
      `</table>`,
      `<p style="margin:0;">${escapeHtml(attachment ? "The sealed PDF is attached." : "The sealed PDF is too large to attach; download it from the portal Documents page.")}</p>`,
    ].join("");
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(`Signed: ${i.title} (${i.clientName})`),
      html: emailLayout({ heading: escapeHtml(`Signed: ${i.title}`), bodyHtml }),
      ...(attachment ? { attachments: [attachment] } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch {
    return { ok: false, error: "Staff notification failed." };
  }
}

export async function notifyStaffClosed(i: {
  to: string[]; title: string; clientName: string; outcome: "declined" | "drift"; reason: string | null; requestId: string;
}): Promise<NotifyResult> {
  try {
    const declined = i.outcome === "declined";
    const heading = declined ? `Declined: ${i.title}` : `Voided (document changed): ${i.title}`;
    const lead = declined
      ? "The signer declined to sign. The document is no longer out for signature."
      : "The source file changed after the request was sent, so the signing link was voided automatically. Review the document and send a new request.";
    const bodyHtml = [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(i.title)}</strong> for ${escapeHtml(i.clientName)}.</p>`,
      `<p style="margin:0 0 12px;">${escapeHtml(lead)}</p>`,
      `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0;">`,
      row(declined ? "Reason given" : "Failed check", i.reason ? escapeMultiline(i.reason) : escapeHtml("None given")),
      row("Request", mono(i.requestId)),
      `</table>`,
    ].join("");
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(`${heading} (${i.clientName})`),
      html: emailLayout({ heading: escapeHtml(heading), bodyHtml }),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch {
    return { ok: false, error: "Staff notification failed." };
  }
}

/** Synchronous so a failure is visible to the signer. The code is never logged. */
export async function sendOtpSms(i: { to: string; code: string }): Promise<NotifyResult> {
  try {
    const r = await sendSms({
      to: i.to,
      body: `${site.name}: your signing code is ${i.code}. It expires in 10 minutes. Don't share this code.`,
    });
    if (r.ok) return { ok: true };
    // sendSms echoes the number on a parse failure; keep it out of anything recorded.
    return { ok: false, error: r.error?.startsWith("Invalid phone number") ? "Invalid phone number." : r.error };
  } catch {
    return { ok: false, error: "SMS send failed." };
  }
}
