import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { readPlatformSecret } from "@/lib/integrations/platform-secrets";
import { contactName, type CrmActivity, type CrmContact } from "./types";

// CRM AI helpers, powered by the same Vault-stored platform Anthropic key as the
// CFO briefing. Sonnet is the default here — fast and inexpensive for the many
// small, interactive calls a CRM makes (summaries, replies, scoring, the bot).

export const CRM_MODEL = "claude-sonnet-5";

export type AiText =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: "no_key" | "refused" | "error"; message: string };

async function anthropic(): Promise<Anthropic | null> {
  const key = await readPlatformSecret("anthropic");
  return key ? new Anthropic({ apiKey: key }) : null;
}

async function complete(system: string, prompt: string, maxTokens = 1200): Promise<AiText> {
  const c = await anthropic();
  if (!c) return { ok: false, reason: "no_key", message: "No Anthropic key configured." };
  try {
    const msg = await c.messages.create({
      model: CRM_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    if (msg.stop_reason === "refusal") {
      return { ok: false, reason: "refused", message: "The model declined." };
    }
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return { ok: false, reason: "error", message: "Empty response." };
    return { ok: true, text, model: msg.model };
  } catch (e) {
    console.error("crm ai:", e);
    const message =
      e instanceof Anthropic.AuthenticationError
        ? "The Anthropic key was rejected (401)."
        : e instanceof Anthropic.APIError
          ? `Anthropic API error (${e.status}).`
          : "Could not reach Anthropic.";
    return { ok: false, reason: "error", message };
  }
}

function timelineToText(activities: CrmActivity[], limit = 40): string {
  return activities
    .slice(0, limit)
    .map((a) => {
      const when = new Date(a.occurred_at).toLocaleDateString("en-US");
      const dir = a.direction ? `${a.direction} ` : "";
      const text = [a.subject, a.body].filter(Boolean).join(" — ").slice(0, 400);
      return `- [${when}] ${dir}${a.type}: ${text || "(no detail)"}`;
    })
    .join("\n");
}

function contactCard(c: CrmContact): string {
  return [
    `Name: ${contactName(c)}`,
    c.title ? `Title: ${c.title}` : "",
    c.email ? `Email: ${c.email}` : "",
    c.phone ? `Phone: ${c.phone}` : "",
    `Lifecycle: ${c.lifecycle_stage}`,
    c.source ? `Source: ${c.source}` : "",
    c.last_contacted_at ? `Last connected: ${new Date(c.last_contacted_at).toLocaleDateString("en-US")}` : "No two-way contact yet",
    c.last_attempt_at ? `Last outreach attempt: ${new Date(c.last_attempt_at).toLocaleDateString("en-US")}` : "",
    c.notes ? `Notes: ${c.notes.slice(0, 500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SYSTEM =
  "You are the sales assistant inside Growth by the Numbers' CRM. GBTN is a fractional-CFO and value-creation firm led by Tyler Briggs, selling to founder-led home/field-services operators ($5M–$150M) and PE-backed platforms. Be concise, specific, and practical. Never invent facts not present in the record.";

export async function summarizeContact(c: CrmContact, timeline: CrmActivity[]): Promise<AiText> {
  return complete(
    SYSTEM,
    `Summarize this prospect in 3-4 tight sentences a CFO could skim before a call: who they are, where the relationship stands, and the single most important thing to know.\n\nCONTACT\n${contactCard(c)}\n\nTIMELINE (newest first)\n${timelineToText(timeline)}`,
    500
  );
}

export async function nextBestAction(c: CrmContact, timeline: CrmActivity[]): Promise<AiText> {
  return complete(
    SYSTEM,
    `Recommend the single next best action to move this deal forward, and why (2-3 sentences). If a specific channel (email/call/text) and timing is warranted, say so.\n\nCONTACT\n${contactCard(c)}\n\nTIMELINE\n${timelineToText(timeline)}`,
    400
  );
}

export async function draftReply(
  c: CrmContact,
  timeline: CrmActivity[],
  opts: { channel: "email" | "sms"; instruction?: string }
): Promise<AiText> {
  const len =
    opts.channel === "sms"
      ? "Keep it under 320 characters, friendly and direct, no subject line."
      : "Write a short, warm, professional email (under 150 words). Include a subject line on the first line prefixed with 'Subject:'.";
  return complete(
    SYSTEM,
    `Draft a ${opts.channel} to this prospect from Tyler. ${len}\n${opts.instruction ? `Goal: ${opts.instruction}\n` : ""}\nCONTACT\n${contactCard(c)}\n\nRECENT TIMELINE\n${timelineToText(timeline, 15)}`,
    600
  );
}

export async function scoreLead(
  c: CrmContact,
  timeline: CrmActivity[]
): Promise<{ score: number; rationale: string } | null> {
  const res = await complete(
    SYSTEM,
    `Score this lead 0-100 for fit and buying intent for GBTN's fractional-CFO services. Respond with ONLY a JSON object: {"score": <int 0-100>, "rationale": "<one sentence>"}.\n\nCONTACT\n${contactCard(c)}\n\nTIMELINE\n${timelineToText(timeline)}`,
    300
  );
  if (!res.ok) return null;
  try {
    const m = res.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { score: number; rationale: string };
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    return { score, rationale: parsed.rationale ?? "" };
  } catch {
    return null;
  }
}

export async function draftCampaign(opts: {
  goal: string;
  channel: "email" | "sms";
  audience?: string;
}): Promise<AiText> {
  return complete(
    SYSTEM,
    `Write a ${opts.channel} campaign message for GBTN.${opts.audience ? ` Audience: ${opts.audience}.` : ""} Goal: ${opts.goal}. Use {{first_name}} where a first name should go. ${
      opts.channel === "email"
        ? "Put a subject line on the first line prefixed 'Subject:'. Keep the body under 180 words."
        : "Keep under 320 characters."
    }`,
    700
  );
}

/** The inbound-SMS auto-responder bot. Returns a suggested reply, or null. */
export async function botReplyToInboundSms(
  c: CrmContact,
  timeline: CrmActivity[],
  inbound: string
): Promise<string | null> {
  const res = await complete(
    SYSTEM,
    `A prospect just texted us. Draft a helpful, concise SMS reply (under 300 characters) from Tyler's team. If the message needs a human (pricing negotiation, complaint, scheduling a specific time), reply with exactly "ESCALATE" and nothing else.\n\nTHEIR MESSAGE: "${inbound}"\n\nCONTACT\n${contactCard(c)}\n\nRECENT TIMELINE\n${timelineToText(timeline, 10)}`,
    300
  );
  if (!res.ok) return null;
  const text = res.text.trim();
  if (text === "ESCALATE" || text.length === 0) return null;
  return text;
}
