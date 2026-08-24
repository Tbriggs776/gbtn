"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { RepStats } from "@/lib/ghl/metrics";
import type { CoachingNote } from "@/lib/ghl/service";
import { dateStamp, duration, percent } from "@/lib/ghl/format";
import {
  generateRepCoachingAction,
  generateTeamCoachingAction,
  type ActionState,
} from "@/app/portal/conversations/actions";
import { Panel, Td, Th } from "./shared";

const initial: ActionState = {};

/**
 * Markdown, rendered small.
 *
 * The coaching prompt asks for H2 headings, numbered actions, and short
 * paragraphs — nothing else — so a full markdown dependency would be four
 * kilobytes to render three constructs. This handles exactly those, and any
 * stray syntax falls through as plain text rather than breaking the page.
 */
function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="max-w-[70ch] space-y-3">
      {blocks.map((block, i) => {
        const heading = block.match(/^#{2,3}\s+(.*)$/);
        if (heading) {
          return (
            <h3
              key={i}
              className="font-label pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted"
            >
              {heading[1]}
            </h3>
          );
        }
        if (/^\s*(?:\d+\.|[-*])\s+/m.test(block)) {
          const items = block.split("\n").filter((l) => l.trim());
          return (
            <ol key={i} className="list-decimal space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink">
              {items.map((item, j) => (
                <li key={j}>{inline(item.replace(/^\s*(?:\d+\.|[-*])\s+/, ""))}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i} className="text-[13.5px] leading-relaxed text-ink">
            {inline(block)}
          </p>
        );
      })}
    </div>
  );
}

/** **bold** and *italic*, nothing more. */
function inline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold">
          {p.slice(2, -2)}
        </strong>
      );
    }
    if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
      return <em key={i}>{p.slice(1, -1)}</em>;
    }
    return <span key={i}>{p}</span>;
  });
}

function GenerateButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-ink disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function NoteBody({ note, empty }: { note: CoachingNote | undefined; empty: string }) {
  if (!note) return <p className="text-[13px] text-muted-soft">{empty}</p>;
  return (
    <>
      <Prose text={note.content} />
      <p className="mt-4 border-t border-line pt-2.5 text-[11px] text-muted-soft">
        Generated {dateStamp(note.generatedAt)} · covers {note.periodStart} to {note.periodEnd}
        {note.model ? ` · ${note.model}` : ""}. Written by AI from the transcripts — read it as a
        starting point for a conversation, not a verdict.
      </p>
    </>
  );
}

export function Coaching({
  clientId,
  reps,
  notes,
  minLeads,
}: {
  clientId: string;
  reps: RepStats[];
  notes: CoachingNote[];
  minLeads: number;
}) {
  const [teamState, teamAction] = useActionState(generateTeamCoachingAction, initial);
  const [repState, repAction] = useActionState(generateRepCoachingAction, initial);
  const [openRep, setOpenRep] = useState<string | null>(reps[0]?.rep ?? null);

  const team = notes.find((n) => n.scope === "team");
  const noteFor = (rep: string) => notes.find((n) => n.scope === "rep" && n.repKey === rep);
  const selected = reps.find((r) => r.rep === openRep) ?? null;

  return (
    <div className="space-y-5">
      <Panel
        title="Team review"
        hint="One read of the year's transcripts: what's happening, what's working, what to change."
        actions={
          <form action={teamAction}>
            <input type="hidden" name="clientId" value={clientId} />
            <GenerateButton
              label={team ? "Regenerate" : "Generate"}
              pendingLabel="Reading transcripts…"
            />
          </form>
        }
      >
        {teamState.error ? (
          <p className="mb-3 rounded-lg border border-crimson/40 bg-crimson/5 px-3 py-2 text-[12px] text-crimson">
            {teamState.error}
          </p>
        ) : null}
        <NoteBody
          note={team}
          empty="No review yet. Generate one once conversations are synced — it reads the year's worst and best threads and writes up what it finds."
        />
      </Panel>

      <Panel
        title="Salespeople"
        hint={`Ranked by volume. Anyone under ${minLeads} leads is listed but not coached — advice drawn from a handful of threads is noise.`}
      >
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Salesperson</Th>
              <Th right>Leads</Th>
              <Th right>Answered</Th>
              <Th right>Never</Th>
              <Th right>Median</Th>
              <Th right>Open-hours</Th>
              <Th right>&lt;5 min</Th>
              <Th right>Notes</Th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => {
              const active = r.rep === openRep;
              return (
                <tr
                  key={r.rep}
                  className={`cursor-pointer transition-colors hover:bg-paper-soft ${active ? "bg-paper-tint" : ""}`}
                  onClick={() => setOpenRep(r.rep)}
                >
                  <Td>
                    <span className={active ? "font-semibold" : undefined}>{r.rep}</span>
                  </Td>
                  <Td right>{r.leads.toLocaleString()}</Td>
                  <Td right flag={r.answerRate < 0.8}>
                    {percent(r.answerRate)}
                  </Td>
                  <Td right flag={r.unanswered > 0}>
                    {r.unanswered.toLocaleString()}
                  </Td>
                  <Td right>{duration(r.medianResponse)}</Td>
                  <Td right>{duration(r.medianBusinessResponse)}</Td>
                  <Td right>{percent(r.fastRate)}</Td>
                  <Td right>
                    {noteFor(r.rep) ? (
                      <span className="text-[11px] text-muted">✓</span>
                    ) : (
                      <span className="text-[11px] text-muted-soft">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
            {reps.length === 0 ? (
              <tr>
                <Td>No leads in this period.</Td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      {selected ? (
        <Panel
          title={`Coaching — ${selected.rep}`}
          hint={`${selected.leads.toLocaleString()} leads · ${percent(selected.answerRate)} answered · median ${duration(selected.medianResponse)}`}
          actions={
            <form action={repAction}>
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="rep" value={selected.rep} />
              <GenerateButton
                label={noteFor(selected.rep) ? "Regenerate" : "Generate"}
                pendingLabel="Reading their threads…"
              />
            </form>
          }
        >
          {repState.error ? (
            <p className="mb-3 rounded-lg border border-crimson/40 bg-crimson/5 px-3 py-2 text-[12px] text-crimson">
              {repState.error}
            </p>
          ) : null}
          <NoteBody
            note={noteFor(selected.rep)}
            empty={`No notes for ${selected.rep} yet. Generate them to get a manager-ready read of their threads.`}
          />
        </Panel>
      ) : null}
    </div>
  );
}
