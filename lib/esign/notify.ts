import "server-only";
import { sendEmail, emailLayout } from "@/lib/email";
import { sendSms } from "@/lib/crm/twilio";
import { site } from "@/lib/site";
import type { RoutingMode, SignatureMethod } from "./types";

// E-sign notifications. Email goes through lib/email.ts directly, not
// lib/crm/comms.ts: these are transactional legal notices to signers, not CRM
// messages (no unsubscribe footer, no crm_messages rows). The audit trail is
// signature_envelope_event (notified / notify_failed), written by the engine
// from these results; nothing here decides DB state.
//
// emailLayout() interpolates heading, ctaLabel, ctaUrl and footnote unescaped,
// so every value handed to it is escaped here. Nothing here throws, and no
// token, OTP code or storage path appears in a return value or a log.

const MAX_ATTACHMENT_BYTES = 15_000_000;

export type NotifyResult = { ok: boolean; error?: string };

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

function paragraph(text: string, last = false): string {
  return `<p style="margin:0${last ? "" : " 0 12px"};">${escapeHtml(text)}</p>`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export async function sendSigningInvite(i: {
  to: string; recipientName: string; title: string; clientName: string; signUrl: string; expiresAt: string;
  routing: RoutingMode; position: { order: number; total: number } | null;
  otherSignerCount: number; isTurnNotice: boolean; requireStaffSession: boolean;
}): Promise<NotifyResult> {
  try {
    const others = Math.max(0, Math.floor(Number(i.otherSignerCount) || 0));
    let orderLine = "";
    if (i.routing === "sequential") {
      if (i.isTurnNotice) {
        orderLine = i.position
          ? `It's your turn: you're signer ${i.position.order} of ${i.position.total}, and everyone before you has signed.`
          : "It's your turn: everyone before you has signed.";
      } else if (i.position) {
        orderLine = `You're signer ${i.position.order} of ${i.position.total}. Signers go in order, and the agreement is complete once everyone has signed.`;
      }
    } else if (others > 0) {
      orderLine = `${plural(others, "other person is", "other people are")} signing too. The agreement is complete once everyone has signed.`;
    }
    const bodyHtml = [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(i.recipientName)},</p>`,
      `<p style="margin:0 0 12px;">${escapeHtml(site.name)} (${escapeHtml(site.legalName)}) has sent you <strong>${escapeHtml(i.title)}</strong> for ${escapeHtml(i.clientName)} to review and sign electronically.</p>`,
      orderLine ? paragraph(orderLine) : "",
      i.requireStaffSession
        ? paragraph(`Sign in to the ${site.shortName} portal first, in the same browser, then open this link. Your countersignature is recorded against your ${site.shortName} account.`)
        : "",
      paragraph(`This link is personal to you. Please don't forward it: anyone with the link can open the signing page. It expires ${arizonaTime(i.expiresAt)}.`),
      paragraph("Questions? Just reply to this email.", true),
    ].join("");
    const subject = i.isTurnNotice ? `Your turn to sign: ${i.title}` : `Please review and sign: ${i.title}`;
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(subject),
      html: emailLayout({
        heading: escapeHtml(subject),
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

/** Non-final signer: confirmation with receipt hash. No PDF (nothing is sealed yet). */
export async function sendRecipientReceipt(i: {
  to: string; recipientName: string; title: string; signedAt: string;
  receiptSha256: string; renderSha256: string; remaining: number;
}): Promise<NotifyResult> {
  try {
    const remaining = Math.max(0, Math.floor(Number(i.remaining) || 0));
    const bodyHtml = [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(i.recipientName)},</p>`,
      `<p style="margin:0 0 12px;">Thank you for signing <strong>${escapeHtml(i.title)}</strong> on ${escapeHtml(arizonaTime(i.signedAt))}.</p>`,
      paragraph(
        remaining > 0
          ? `We're waiting on ${plural(remaining, "more signer", "more signers")}. When everyone has signed, you'll get the executed copy by email.`
          : "When the executed copy is ready, you'll get it by email."
      ),
      `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0;">`,
      row("Your receipt", mono(i.receiptSha256)),
      row("Document SHA-256", mono(i.renderSha256)),
      `</table>`,
    ].join("");
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(`Signed: ${i.title} (waiting on other signers)`),
      html: emailLayout({
        heading: escapeHtml(`You signed: ${i.title}`),
        bodyHtml,
        footnote: escapeHtml("Keep this email: the receipt hash lets anyone confirm your signature in the executed copy."),
      }),
      replyTo: site.founder.email,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch {
    return { ok: false, error: "Receipt email failed." };
  }
}

/** Every recipient, at completion. */
export async function sendCompletedCopy(i: {
  to: string; recipientName: string; title: string; completedAt: string;
  sealedSha256: string; pdf: Uint8Array; fileName: string;
}): Promise<NotifyResult> {
  try {
    const attachment = pdfAttachment(i.pdf, i.fileName);
    const copyLine = attachment
      ? "The executed copy is attached. You can also download it from your signing link within 30 days."
      : "The executed PDF is too large to attach; download it from your signing link within 30 days, or reply to ask GBTN for a copy.";
    const bodyHtml = [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(i.recipientName)},</p>`,
      `<p style="margin:0 0 12px;">Everyone has signed <strong>${escapeHtml(i.title)}</strong>. It was completed on ${escapeHtml(arizonaTime(i.completedAt))}.</p>`,
      paragraph(copyLine),
      `<p style="margin:0 0 4px;">SHA-256 of the sealed file, so any later change is detectable:</p>`,
      `<p style="margin:0;">${mono(i.sealedSha256)}</p>`,
    ].join("");
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(`Completed: ${i.title}`),
      html: emailLayout({
        heading: escapeHtml(`Completed: ${i.title}`),
        bodyHtml,
        footnote: escapeHtml("You can request a paper copy at any time, at no charge, by replying to this email."),
      }),
      replyTo: site.founder.email,
      ...(attachment ? { attachments: [attachment] } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch {
    return { ok: false, error: "Completed copy email failed." };
  }
}

/** Flags every recipient whose printed name differs from the name the envelope was sent to (I41). */
export async function notifyStaffCompleted(i: {
  to: string[]; title: string; clientName: string; envelopeId: string; completedAt: string;
  sealedSha256: string; engagementActivated: boolean; pdf: Uint8Array; fileName: string;
  recipients: { name: string; printedName: string; email: string; method: SignatureMethod }[];
}): Promise<NotifyResult> {
  try {
    const attachment = pdfAttachment(i.pdf, i.fileName);
    const mismatched = i.recipients.filter((r) => normalizeName(r.printedName) !== normalizeName(r.name));
    const signerRows = i.recipients.map((r, n) =>
      row(
        `Signer ${n + 1}`,
        `${escapeHtml(r.name)} &lt;${escapeHtml(r.email)}&gt;<br>Printed name: ${escapeHtml(r.printedName)} · ${escapeHtml(r.method === "typed" ? "Typed" : "Drawn")}`
      )
    );
    const bodyHtml = [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(i.title)}</strong> for ${escapeHtml(i.clientName)} has been signed by everyone and sealed.</p>`,
      mismatched.length > 0
        ? `<p style="margin:0 0 12px;color:#9e2335;"><strong>Printed name differs from the name it was sent to for: ${escapeHtml(mismatched.map((r) => r.name).join(", "))}. Review before relying on it.</strong></p>`
        : "",
      `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 12px;">`,
      ...signerRows,
      row("Completed", escapeHtml(arizonaTime(i.completedAt))),
      row("Engagement", escapeHtml(i.engagementActivated ? "Linked engagement is now active." : "No engagement change.")),
      row("Envelope", mono(i.envelopeId)),
      row("Sealed SHA-256", mono(i.sealedSha256)),
      `</table>`,
      paragraph(attachment ? "The sealed PDF is attached." : "The sealed PDF is too large to attach; download it from the portal Documents page.", true),
    ].join("");
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(`Completed: ${i.title} (${i.clientName})`),
      html: emailLayout({ heading: escapeHtml(`Completed: ${i.title}`), bodyHtml }),
      ...(attachment ? { attachments: [attachment] } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch {
    return { ok: false, error: "Staff notification failed." };
  }
}

export async function notifyStaffClosed(i: {
  to: string[]; title: string; clientName: string; envelopeId: string;
  outcome: "declined" | "drift" | "expired" | "seal_failed" | "abandoned";
  reason: string | null; declinedBy: string | null; attempt: number | null;
}): Promise<NotifyResult> {
  try {
    let heading: string;
    let lead: string;
    let reasonLabel: string;
    switch (i.outcome) {
      case "declined":
        heading = `Declined: ${i.title}`;
        lead = `${i.declinedBy ?? "A signer"} declined to sign. The envelope is closed and the document is no longer out for signature.`;
        reasonLabel = "Reason given";
        break;
      case "drift":
        heading = `Voided (document changed): ${i.title}`;
        lead = "A file changed after the envelope was sent, so every signing link was voided automatically. Review the document and send a new envelope.";
        reasonLabel = "Failed check";
        break;
      case "expired":
        heading = `Expired: ${i.title}`;
        lead = "The signing links expired before everyone signed. The document is no longer out for signature.";
        reasonLabel = "Note";
        break;
      case "seal_failed":
        heading = `Sealing failed: ${i.title}`;
        lead = "Everyone has signed, but the executed copy couldn't be built. Sealing retries on its own; use Finish sealing on the Documents page, or abandon sealing after 30 minutes.";
        reasonLabel = "Error";
        break;
      default:
        heading = `Sealing abandoned: ${i.title}`;
        lead = "Sealing was abandoned. The envelope is voided and the document restored; send it again when you're ready.";
        reasonLabel = "Reason given";
        break;
    }
    const bodyHtml = [
      `<p style="margin:0 0 12px;"><strong>${escapeHtml(i.title)}</strong> for ${escapeHtml(i.clientName)}.</p>`,
      paragraph(lead),
      `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0;">`,
      row(reasonLabel, i.reason ? escapeMultiline(i.reason) : escapeHtml("None given")),
      i.outcome === "seal_failed" && i.attempt !== null ? row("Attempt", escapeHtml(String(i.attempt))) : "",
      row("Envelope", mono(i.envelopeId)),
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

/** Activated recipients who never signed, when an envelope closes early. Never the reason. */
export async function notifyRecipientsWithdrawn(i: {
  to: string; recipientName: string; title: string; outcome: "voided" | "declined" | "expired" | "abandoned";
}): Promise<NotifyResult> {
  try {
    const why =
      i.outcome === "declined"
        ? "Another signer declined, so the request was closed."
        : i.outcome === "expired"
          ? "It expired before everyone signed."
          : `${site.name} withdrew it.`;
    const bodyHtml = [
      `<p style="margin:0 0 12px;">Hi ${escapeHtml(i.recipientName)},</p>`,
      `<p style="margin:0 0 12px;">The signature request for <strong>${escapeHtml(i.title)}</strong> is no longer open. ${escapeHtml(why)}</p>`,
      paragraph("You don't need to do anything, and your signing link no longer works. If your signature is still needed, you'll receive a new email."),
      paragraph("Questions? Just reply to this email.", true),
    ].join("");
    const r = await sendEmail({
      to: i.to,
      subject: oneLine(`Signature request closed: ${i.title}`),
      html: emailLayout({ heading: escapeHtml(`Signature request closed: ${i.title}`), bodyHtml }),
      replyTo: site.founder.email,
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch {
    return { ok: false, error: "Withdrawal email failed." };
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
