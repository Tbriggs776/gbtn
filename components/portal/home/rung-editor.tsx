"use client";

import { unstable_rethrow, useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { setEngagementRungAction, type SetRungResult } from "@/lib/crm/engagement-actions";
import { OFFER_RUNGS, RUNG_LABEL, type OfferRung } from "@/lib/crm/types";

// Admin-only rung control on the portal home engagement strip. The parent
// renders it only for platform admins; the action re-asserts assertAdmin.

type Msg = { tone: "ok" | "error"; text: string };

function toRung(v: string): OfferRung | null {
  for (const r of OFFER_RUNGS) if (r === v) return r;
  return null;
}

function describe(d: SetRungResult | undefined): Msg {
  if (!d) return { tone: "ok", text: "Saved." };
  if (d.rung === null) return { tone: "ok", text: "Saved. Rung cleared; phases are untouched." };
  const s = d.seed;
  if (!s) return { tone: "ok", text: "Saved." };
  switch (s.status) {
    case "seeded":
      return {
        tone: "ok",
        text: `Saved. Default ${RUNG_LABEL[d.rung]} checklist added (${s.phases} phases, ${s.deliverables} deliverables).`,
      };
    case "skipped_existing":
      return { tone: "ok", text: "Saved. Existing phases kept." };
    case "skipped_race":
      return { tone: "ok", text: "Saved. Phases were added at the same time, so no checklist was added." };
    case "failed":
      return {
        tone: "error",
        text: s.rolledBack
          ? `Rung saved, but the checklist wasn't added (${s.stage}). Try Add checklist again.`
          : `Rung saved, but the checklist may be incomplete (${s.stage}). Check the phases before retrying.`,
      };
  }
}

export function RungEditor({
  engagementId,
  clientId,
  rung,
  phaseCount,
  phasesFailed,
  nameFollowsRung,
}: {
  engagementId: string;
  clientId: string;
  rung: OfferRung | null;
  phaseCount: number;
  phasesFailed: boolean;
  nameFollowsRung: boolean;
}) {
  const router = useRouter();
  const selectId = useId();
  const statusId = useId();
  const [value, setValue] = useState<string>(rung ?? "");
  // What the server last confirmed. Updated from the action result, so a second
  // click before router.refresh() lands never sends a stale expectedRung.
  const [baseRung, setBaseRung] = useState<OfferRung | null>(rung);
  const [seedAttempted, setSeedAttempted] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [pending, start] = useTransition();

  // Re-sync when router.refresh() delivers new server values.
  useEffect(() => {
    setBaseRung(rung);
    setValue(rung ?? "");
  }, [rung]);
  useEffect(() => setSeedAttempted(false), [phaseCount]);

  const next = toRung(value);
  const changed = next !== baseRung;
  const needsSeed = !changed && baseRung !== null && phaseCount === 0 && !phasesFailed && !seedAttempted;
  const canSubmit = !pending && (changed || needsSeed);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    const seedChecklist = needsSeed;
    setMsg(null);
    start(async () => {
      let res: Awaited<ReturnType<typeof setEngagementRungAction>>;
      try {
        res = await setEngagementRungAction({
          engagementId,
          clientId,
          rung: next,
          expectedRung: baseRung,
          seedChecklist,
        });
      } catch (err) {
        // A transport failure or deploy skew rejects here, outside the action's
        // own try/catch. With no error.tsx it would blank the page, so report it
        // inline — but let a signed-out redirect through to Next.
        unstable_rethrow(err);
        setMsg({ tone: "error", text: "Couldn't reach the server. Refresh and try again." });
        return;
      }
      if (!res.ok) {
        setMsg({ tone: "error", text: res.error });
        return;
      }
      setBaseRung(res.data?.rung ?? null);
      if (res.data?.seed && res.data.seed.status !== "failed") setSeedAttempted(true);
      setMsg(describe(res.data));
      router.refresh();
    });
  }

  return (
    <div className="mt-3">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-describedby={statusId}>
        <label htmlFor={selectId} className="text-[11px] font-semibold text-muted-soft">
          Set rung
        </label>
        <select
          id={selectId}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setMsg(null);
          }}
          disabled={pending}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
        >
          <option value="">Unset</option>
          {OFFER_RUNGS.map((r) => (
            <option key={r} value={r}>
              {RUNG_LABEL[r]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!canSubmit}
          className="min-w-24 rounded-md bg-ink px-2.5 py-1 text-xs font-semibold text-white hover:bg-ink/90 disabled:opacity-40"
        >
          {pending ? "Saving…" : needsSeed ? "Add checklist" : "Save"}
        </button>
      </form>
      {/* Reserved height: the status line never shifts the strip. */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={`mt-1 min-h-4 max-w-xs text-xs ${msg?.tone === "error" ? "text-red-700" : "text-muted-soft"}`}
      >
        {msg?.text ?? ""}
      </p>
      {nameFollowsRung ? (
        <p className="max-w-xs text-xs text-muted-soft">Converted from a deal: the name clients see follows the rung.</p>
      ) : null}
    </div>
  );
}
