// Pure mail → card proposal. No database. The staff paste modal imports this
// for the preview, and the ingest API runs the same function before it writes.
//
// Owner and column here are a suggestion. Auto-create (the API) always stores
// status inbox and owner null; the suggestion is repeated in notes. The paste
// UI may apply the suggested owner when confidence is high.

import { OPS_BOARD_TZ, type OpsBoardOwner } from "@/lib/ops-board/types";

export type IngestMailInput = {
  externalKey?: string | null;
  from?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  receivedAt?: string | null;
};

export type IngestProposal = {
  action: "create" | "skip";
  reason?: string;
  title: string;
  next_action: string | null;
  /** Suggestion only. Not the owner written by the API. */
  owner: OpsBoardOwner | null;
  ownerConfidence: "high" | "low" | "none";
  ownerRationale: string | null;
  /** Always inbox. Column moves stay on the existing board actions. */
  status: "inbox";
  due_on: string | null;
  source: string;
  notes: string;
};

const AUTO_REPLY =
  /\b(automatic reply|auto-reply|autoreply|out of office|out-of-office|i am currently out|i'm out of the office|i am out of the office|mailer-daemon|delivery status notification|undeliverable)\b/i;

const CALENDAR_SUBJECT =
  /^(?:(?:re|fw|fwd):\s*)*(?:invitation|accepted|declined|tentative|canceled|cancelled|updated invitation)\s*:/i;

const NEWSLETTER =
  /\b(view (?:this|in) (?:email|browser)|you (?:are|were) receiving this|email preferences|manage (?:your )?subscription|newsletter)\b/i;

const SOCIAL =
  /\b(lunch|dinner|breakfast|birthday|happy hour|weekend plans|game night)\b/i;

const ASK =
  /\b(please|can you|could you|need you to|needs to|action needed|follow up|approve|review|send me|let me know)\b/i;

const JOB_ID = /\bCG\d{4,}\b/i;

const STRONG_OPS = /\b(CG\d{4,}|paychex|statement approval)\b/i;

/** Ops signals other than a bare "GL", which is too easy to trip. */
const OPS_KEYWORD =
  /\b(paychex|payroll|quickbooks|QBO|install(?:ation|s)?|refunds?|past[- ]due|statement approval|commissions?|new[- ]hires?|paperwork|time (?:and|&) attendance|general ledger|GL|RFMS)\b|\bT\s*&\s*A\b/i;

const FLOOR_DADDY = /\bfloor\s*daddy\b/i;

const KAREN_TOPIC =
  /\b(karen|accounting|payroll|paychex|refunds?|paperwork|new[- ]hires?|commissions?|statement approval|time (?:and|&) attendance|general ledger|GL)\b|\bT\s*&\s*A\b/gi;

const TYLER_TOPIC = /\b(tyler|quickbooks|QBO)\b/gi;

export function ingestKeyMaterial(from: string, subject: string, receivedAt: string): string {
  // Spec: sha256 of lower(from)|subject|date. Only the address is lowercased.
  return `${from.trim().toLowerCase()}|${subject.trim()}|${receivedAt.trim()}`;
}

export async function hashIngestKey(from: string, subject: string, receivedAt: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ingestKeyMaterial(from, subject, receivedAt))
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function splitPastedEmail(raw: string): {
  from: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
} | null {
  const text = raw.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
  if (!/^From:/im.test(text) || !/^Subject:/im.test(text)) return null;
  const from = /^From:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
  const subject = /^Subject:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
  if (!from && !subject) return null;
  const dateRaw = /^Date:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
  const splitAt = text.search(/\n\n/);
  const bodyText = (splitAt >= 0 ? text.slice(splitAt + 2) : text).trim();
  return { from, subject, bodyText, receivedAt: toYmd(dateRaw) };
}

export function classifyIngestMail(input: IngestMailInput): IngestProposal {
  const from = (input.from ?? "").trim();
  const subject = (input.subject ?? "").trim();
  const body = (input.bodyText ?? "").trim();
  const receivedAt = (input.receivedAt ?? "").trim();
  const externalKey = (input.externalKey ?? "").trim();
  const blob = `${subject}\n${body}`;
  const head = `${subject}\n${body.slice(0, 400)}`;

  const skipReason = noiseReason(from, subject, body, head, blob);
  const suggestion = suggestOwner(subject, body);
  const due_on = extractDue(blob);
  const title = buildTitle(subject, blob);
  const source = sourceLine(subject, externalKey);
  const next_action = skipReason ? null : nextAction(blob);

  const notes = renderNotes({
    from,
    receivedAt,
    externalKey,
    suggestion,
    body,
  });

  if (skipReason) {
    return {
      action: "skip",
      reason: skipReason,
      title,
      next_action: null,
      owner: null,
      ownerConfidence: "none",
      ownerRationale: null,
      status: "inbox",
      due_on: null,
      source,
      notes,
    };
  }

  return {
    action: "create",
    title,
    next_action,
    owner: suggestion.owner,
    ownerConfidence: suggestion.confidence,
    ownerRationale: suggestion.rationale,
    status: "inbox",
    due_on,
    source,
    notes,
  };
}

function noiseReason(from: string, subject: string, body: string, head: string, blob: string): string | null {
  const strong = STRONG_OPS.test(blob) || hasCod(blob);
  if (AUTO_REPLY.test(subject) || AUTO_REPLY.test(head.slice(0, 500))) {
    // An out-of-office or bounce is not an ask, even when the quoted thread
    // mentions a job. The person did not send work.
    return "auto-reply";
  }
  const calendar = CALENDAR_SUBJECT.test(subject) || /BEGIN:VCALENDAR/i.test(body);
  const actionable = isActionable(from, blob);
  if (calendar && !actionable) return "calendar invite with no ask";
  if (isMarketing(from, subject, body) && !strong) return "newsletter or marketing";
  if (SOCIAL.test(blob) && !JOB_ID.test(blob) && !OPS_KEYWORD.test(blob) && !hasCod(blob)) {
    return "personal, no ops ask";
  }
  if (!actionable) return "no actionable Floor Daddy ops ask";
  return null;
}

function isMarketing(from: string, subject: string, body: string): boolean {
  const unsub = body.match(/\bunsubscribe\b/gi)?.length ?? 0;
  if (unsub >= 2) return true;
  if (unsub >= 1 && NEWSLETTER.test(`${subject}\n${body}`)) return true;
  if (/\b(?:no-?reply|newsletter|marketing|promotions)@/i.test(from) && (unsub >= 1 || NEWSLETTER.test(body))) {
    return true;
  }
  return false;
}

function isActionable(from: string, blob: string): boolean {
  if (JOB_ID.test(blob) || OPS_KEYWORD.test(blob) || hasCod(blob)) return true;
  if (/\bRFMS\b/i.test(blob) || /\b(?:order|job|invoice)\s*#?\s*\d{5,}\b/i.test(blob)) return true;
  const named = /\b(tyler|karen)\b/i.test(blob);
  if (named && ASK.test(blob)) return true;
  if (FLOOR_DADDY.test(`${from}\n${blob}`) && ASK.test(blob)) return true;
  return false;
}

function hasCod(text: string): boolean {
  return /\bCOD\b/.test(text) || /cash on delivery/i.test(text);
}

function suggestOwner(subject: string, body: string): {
  owner: OpsBoardOwner | null;
  confidence: "high" | "low" | "none";
  rationale: string | null;
} {
  const head = `${subject}\n${body.slice(0, 500)}`;
  const greet = head.match(/(?:^|\n)\s*(?:hi|hey|hello|dear)\s+(tyler|karen)\b/i);
  const lead = head.match(/(?:^|\n)\s*(tyler|karen)\s*[,:—–-]/i);
  const subjectName =
    subject.match(/\b(?:for|attn:?|attention:?)\s+(tyler|karen)\b/i) ??
    subject.match(/\b(tyler|karen)\s*[—–:-]/i);
  const named = (greet?.[1] ?? lead?.[1] ?? subjectName?.[1] ?? "").toLowerCase();
  if (named === "tyler" || named === "karen") {
    const who = named === "tyler" ? "Tyler" : "Karen";
    return { owner: named, confidence: "high", rationale: `Addressed to ${who}.` };
  }

  const karenHits = bodyAndSubjectHits(KAREN_TOPIC, `${subject}\n${body}`);
  const tylerHits = bodyAndSubjectHits(TYLER_TOPIC, `${subject}\n${body}`);
  if (karenHits > 0 && karenHits >= tylerHits) {
    return {
      owner: "karen",
      confidence: "low",
      rationale: "Mentions Karen's lane (accounting, payroll, refunds, or paperwork).",
    };
  }
  if (tylerHits > 0) {
    return { owner: "tyler", confidence: "low", rationale: "Mentions Tyler or QuickBooks." };
  }
  return { owner: null, confidence: "none", rationale: null };
}

function bodyAndSubjectHits(re: RegExp, text: string): number {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const copy = new RegExp(re.source, flags);
  return text.match(copy)?.length ?? 0;
}

function nextAction(blob: string): string {
  if (/statement approval/i.test(blob)) return "Approve the statement";
  if (/new[- ]hire|paperwork/i.test(blob)) return "Complete the new-hire paperwork";
  if (/missed install|install(?:ation)? miss/i.test(blob)) return "Follow up on the missed install";
  if (/past[- ]due|collect(?:ing)? (?:the )?balance/i.test(blob)) return "Collect the open balance";
  if (/refunds?/i.test(blob)) return "Review the refund";
  if (/paychex|payroll|\bT\s*&\s*A\b|time (?:and|&) attendance/i.test(blob)) return "Review the payroll item";
  if (hasCod(blob)) return "Confirm the COD";
  if (/commissions?/i.test(blob)) return "Review the commission";
  if (/quickbooks|\bQBO\b/i.test(blob)) return "Review the QuickBooks item";
  const job = blob.match(JOB_ID);
  if (job) return `Follow up on ${job[0].toUpperCase()}`;
  return "Review and reply";
}

function buildTitle(subject: string, blob: string): string {
  let title = stripReply(subject);
  const job = blob.match(JOB_ID);
  if (job && !title.toUpperCase().includes(job[0].toUpperCase())) {
    title = title ? `${job[0].toUpperCase()} — ${title}` : job[0].toUpperCase();
  }
  if (!title) title = "Ops email";
  return clip(title, 100);
}

function stripReply(subject: string): string {
  let s = subject.replace(/\s+/g, " ").trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(?:re|fw|fwd)\s*:\s*/i, "").trim();
  }
  return s;
}

function clip(value: string, max: number): string {
  const s = value.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > 40 ? cut.slice(0, space) : cut).trim();
}

function sourceLine(subject: string, externalKey: string): string {
  const cleaned = subject.replace(/\s+/g, " ").trim();
  if (cleaned) return `email: ${clip(cleaned, 180)}`;
  const short = externalKey.replace(/\s+/g, "").slice(0, 24);
  return short ? `ingest:${short}` : "ingest:email";
}

function renderNotes(args: {
  from: string;
  receivedAt: string;
  externalKey: string;
  suggestion: { owner: OpsBoardOwner | null; confidence: "high" | "low" | "none"; rationale: string | null };
  body: string;
}): string {
  const who =
    args.suggestion.owner === "tyler" ? "Tyler" : args.suggestion.owner === "karen" ? "Karen" : null;
  const suggestion = who
    ? `Suggested owner: ${who} — ${args.suggestion.rationale ?? "ops mail."} Auto-ingest leaves the card in Inbox, unassigned.`
    : "Suggested owner: none. Auto-ingest leaves the card in Inbox, unassigned.";
  const lines = [
    `From: ${args.from || "(unknown)"}`,
    `Received: ${args.receivedAt || "unknown"}`,
    `external_key: ${args.externalKey || "(pending)"}`,
    "",
    suggestion,
    "",
    excerpt(args.body),
  ];
  return lines.join("\n").slice(0, 4000);
}

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "(no body)";
  const sentences = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
  let text = (sentences.length ? sentences.slice(0, 4) : [flat]).join(" ");
  if (text.length > 700) text = `${text.slice(0, 697).trimEnd()}…`;
  return text;
}

function extractDue(text: string): string | null {
  const iso = text.match(/\b(?:due|by|before)\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (iso && isYmd(iso[1])) return iso[1];
  const us = text.match(/\b(?:due|by|before)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
  if (us) {
    const ymd = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    if (isYmd(ymd)) return ymd;
  }
  return null;
}

function isYmd(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function toYmd(value: string): string {
  const direct = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (direct) return direct[1];
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OPS_BOARD_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(parsed));
}
