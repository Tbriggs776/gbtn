import "server-only";
import { generate, BRIEFING_MODEL } from "@/lib/ai/anthropic";
import { redact } from "./map";
import { getTranscripts, saveNote } from "./service";
import {
  bestThreads,
  byRep,
  summarize,
  worstThreads,
  type RepStats,
  type Summary,
} from "./metrics";
import type { ConversationRow, Message } from "./types";

// The AI half of the module: turn transcripts into coaching a manager can act
// on tomorrow morning.
//
// The deterministic metrics (metrics.ts) already answer "what happened". They
// cannot answer "why", and the why is in the wording — the rep who answers in
// 90 seconds but never asks for the appointment loses the job just as surely as
// the one who never answers. That's what this pass reads for.
//
// Two rules shape everything below:
//   1. The model NEVER sees a number it could get wrong. Every statistic in the
//      prompt is pre-computed and stated; the model is asked to explain and
//      advise, not to count. Asking an LLM to tally 400 threads is how a report
//      ends up confidently wrong.
//   2. Contact details are stripped before the transcript leaves this server.
//      Coaching doesn't need a customer's phone number.

/** How many transcripts to include. Enough to see a pattern, few enough to
 *  stay inside a sane prompt and a sane bill. */
const WORST_SAMPLE = 12;
const BEST_SAMPLE = 5;
/** Messages per transcript. Long email chains are mostly quoted history. */
const MAX_MESSAGES = 24;
/** Characters per message body. */
const MAX_BODY = 600;

const SYSTEM = `You are a sales-floor coach for a flooring retailer, reporting to a fractional CFO who advises the owner.

You are given (a) already-computed statistics about how the business handles inbound leads and (b) a sample of real message transcripts. The statistics are correct — never recompute, contradict, or re-estimate them. Your job is to explain what the transcripts show and say what to do about it.

Ground every claim in something you can point at: a stated statistic or a specific transcript. If the sample does not support a claim, do not make it. When the evidence is thin, say so plainly rather than hedging with vague language.

Write for a busy owner. Short paragraphs, plain words, no jargon, no filler openers. Prefer the concrete instruction ("text back within five minutes with a time offer, not a question") over the abstract one ("improve responsiveness"). Never invent names, dollar figures, or outcomes that are not in the material.`;

/**
 * A transcript, flattened for the prompt.
 *
 * This is the only function that hands conversation content to a third party,
 * so it is the one place a reviewer has to check — and every body goes through
 * redact() (lib/ghl/map.ts) on the way out.
 */
function renderTranscript(row: ConversationRow, messages: Message[]): string {
  const head = [
    `Thread ${row.ghlId}`,
    `channel: ${row.channel}`,
    `rep: ${row.assignedUserName ?? "unassigned"}`,
    row.responseSeconds !== null
      ? `first human reply after: ${humanDuration(row.responseSeconds)}`
      : row.autoRepliedOnly
        ? "never answered by a person (automation replied)"
        : "never answered",
    `${row.inboundCount} in / ${row.outboundCount} out`,
  ].join(" · ");

  // Keep the opening (how the lead framed it) and the ending (how it died).
  const trimmed =
    messages.length <= MAX_MESSAGES
      ? messages
      : [...messages.slice(0, MAX_MESSAGES / 2), ...messages.slice(-MAX_MESSAGES / 2)];

  const body = trimmed
    .map((m) => {
      const who =
        m.direction === "inbound" ? "CUSTOMER" : m.automated ? "AUTOMATION" : "REP";
      const text = redact(m.body ?? "").slice(0, MAX_BODY);
      return `[${who}${m.dateAdded ? ` ${m.dateAdded.slice(0, 16).replace("T", " ")}` : ""}] ${text || "(no text — attachment or call)"}`;
    })
    .join("\n");

  return `${head}\n${body}`;
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function statLine(s: Summary): string {
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
  return [
    `Leads (someone wrote in): ${s.leads}`,
    `Answered by a person: ${s.answered} (${pct(s.answered, s.leads)})`,
    `Never answered by a person: ${s.unanswered} (${pct(s.unanswered, s.leads)})`,
    `  …of which the automation replied and nobody followed up: ${s.autoRepliedOnly}`,
    `Median time to first human reply: ${s.medianResponse === null ? "n/a" : humanDuration(s.medianResponse)}`,
    `Slowest 10% wait at least: ${s.p90Response === null ? "n/a" : humanDuration(s.p90Response)}`,
    `Median counting only open hours: ${s.medianBusinessResponse === null ? "n/a" : humanDuration(s.medianBusinessResponse)}`,
    `Answered within 5 minutes: ${s.withinFive} of ${s.answered} answered (${pct(s.withinFive, s.answered)})`,
    `Answered within 1 hour: ${s.withinHour} of ${s.answered} answered (${pct(s.withinHour, s.answered)})`,
    `Leads that arrived outside open hours: ${s.afterHoursLeads} (${pct(s.afterHoursLeads, s.leads)})`,
  ].join("\n");
}

function repLine(r: RepStats): string {
  return [
    r.rep,
    `${r.leads} leads`,
    `${Math.round(r.answerRate * 100)}% answered`,
    `median ${r.medianResponse === null ? "n/a" : humanDuration(r.medianResponse)}`,
    `${Math.round(r.fastRate * 100)}% inside 5 min`,
    `${r.unanswered} never answered`,
  ].join(" · ");
}

// ── The two generations ──────────────────────────────────────────────────────

export type CoachingInput = {
  clientId: string;
  clientName: string;
  rows: ConversationRow[];
  periodStart: string;
  periodEnd: string;
  generatedBy: string | null;
};

/**
 * One write-up for the whole floor: what the year's conversations show, and the
 * three or four changes worth making.
 */
export async function generateTeamCoaching(
  input: CoachingInput
): Promise<{ ok: true; content: string } | { ok: false; message: string }> {
  const { rows, clientName, periodStart, periodEnd } = input;
  const summary = summarize(rows);
  if (summary.leads === 0) {
    return { ok: false, message: "No inbound leads in this period to analyse." };
  }

  const worst = worstThreads(rows, WORST_SAMPLE);
  const best = bestThreads(rows, BEST_SAMPLE);
  const transcripts = await getTranscripts(
    input.clientId,
    [...worst, ...best].map((r) => r.id)
  );

  const prompt = `${clientName} — inbound lead handling, ${periodStart} to ${periodEnd}.

## Statistics (already computed — treat as fact)
${statLine(summary)}

## By salesperson
${byRep(rows).map(repLine).join("\n")}

## Transcripts that went badly (the ${worst.length} highest-cost threads)
${worst.map((r) => renderTranscript(r, transcripts.get(r.id) ?? [])).join("\n\n---\n\n")}

## Transcripts that went well (${best.length} of the fastest, most engaged threads)
${best.map((r) => renderTranscript(r, transcripts.get(r.id) ?? [])).join("\n\n---\n\n")}

---

Write the coaching review. Use exactly these four sections, as markdown H2 headings:

## What the numbers say
Two or three sentences. Lead with the single most expensive fact.

## What the transcripts show
The recurring patterns — how leads are opened, what reps say, where threads die. Quote short fragments as evidence. Distinguish a habit that shows up repeatedly from a one-off.

## What's working
What the good threads do differently, specifically enough to copy.

## Do this next
Three to five numbered actions, most valuable first. Each one names who does it and what changes. Include the process/staffing fix where the data points at coverage rather than effort — do not coach a rep for a gap that is really a rota problem.`;

  const result = await generate(SYSTEM, prompt, 8000);
  if (!result.ok) return { ok: false, message: result.message };

  await saveNote(
    input.clientId,
    {
      scope: "team",
      repKey: null,
      content: result.text,
      model: result.model ?? BRIEFING_MODEL,
      periodStart,
      periodEnd,
    },
    input.generatedBy
  );
  return { ok: true, content: result.text };
}

/**
 * One write-up per salesperson.
 *
 * Reps below the threshold are skipped rather than given thin advice: coaching
 * somebody on a median drawn from four threads is noise, and it's the fastest
 * way to lose the floor's trust in the whole report.
 */
export const MIN_LEADS_FOR_REP_COACHING = 10;

export async function generateRepCoaching(
  input: CoachingInput,
  rep: string
): Promise<{ ok: true; content: string } | { ok: false; message: string }> {
  const { rows, clientName, periodStart, periodEnd } = input;
  const mine = rows.filter((r) => (r.assignedUserName?.trim() || "Unassigned") === rep);
  const stats = byRep(rows).find((r) => r.rep === rep);

  if (!stats || stats.leads < MIN_LEADS_FOR_REP_COACHING) {
    return {
      ok: false,
      message: `${rep} handled fewer than ${MIN_LEADS_FOR_REP_COACHING} leads in this period — too few to coach on.`,
    };
  }

  const worst = worstThreads(mine, 8);
  const best = bestThreads(mine, 3);
  const transcripts = await getTranscripts(
    input.clientId,
    [...worst, ...best].map((r) => r.id)
  );

  const floor = summarize(rows);
  const prompt = `${clientName} — coaching notes for ${rep}, ${periodStart} to ${periodEnd}.

## This person (already computed — treat as fact)
${repLine(stats)}
Median counting only open hours: ${stats.medianBusinessResponse === null ? "n/a" : humanDuration(stats.medianBusinessResponse)}
Outbound messages sent: ${stats.messagesSent}

## The floor, for comparison
Median time to first human reply: ${floor.medianResponse === null ? "n/a" : humanDuration(floor.medianResponse)}
Answered at all: ${Math.round(floor.answerRate * 100)}%
Inside 5 minutes: ${Math.round(floor.fastRate * 100)}%

## Their threads that went badly
${worst.map((r) => renderTranscript(r, transcripts.get(r.id) ?? [])).join("\n\n---\n\n")}

## Their threads that went well
${best.length > 0 ? best.map((r) => renderTranscript(r, transcripts.get(r.id) ?? [])).join("\n\n---\n\n") : "(none in this period met the bar)"}

---

Write coaching notes addressed to their manager, not to the rep. Use exactly these three sections, as markdown H2 headings:

## Where they stand
Two or three sentences against the floor. Be fair: say plainly when they are ahead.

## The pattern to fix
The one habit worth changing, with transcript evidence. One habit, not a list — a manager can land one change.

## How to say it
A short script the manager can use in a five-minute conversation this week.`;

  const result = await generate(SYSTEM, prompt, 4000);
  if (!result.ok) return { ok: false, message: result.message };

  await saveNote(
    input.clientId,
    {
      scope: "rep",
      repKey: rep,
      content: result.text,
      model: result.model ?? BRIEFING_MODEL,
      periodStart,
      periodEnd,
    },
    input.generatedBy
  );
  return { ok: true, content: result.text };
}
