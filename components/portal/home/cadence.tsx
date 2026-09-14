import Link from "next/link";
import type { ReactNode } from "react";
import type { Cadence, CadencePhase, CadenceOnboarding } from "@/lib/engagements/portal-model";
import { HomeSection, Pill, SoftNote } from "./section";

// Cadence: what is happening now and what comes next, read from the existing
// 0029 phases, deliverables and onboarding checklist. Read-only — there is no
// phase editor in Phase 2.

const CARD = "rounded-2xl border border-line bg-white p-6 ring-soft";
const EYEBROW = "text-xs font-semibold uppercase tracking-wide text-muted-soft";
const COLS: Record<number, string> = { 1: "", 2: "lg:grid-cols-2", 3: "lg:grid-cols-3" };

const EMPTY_TITLE = "Cadence will show here once phases are set";
const EMPTY_CLIENT_BODY =
  "GBTN maps each engagement into phases and deliverables, so you can see what's happening now and what comes next.";
const EMPTY_STAFF_BODY = "This engagement has no phases yet.";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function CadenceSection({
  cadence,
  showStaffDetail,
  showOnboardingItems,
  documentsHref,
}: {
  cadence: Cadence;
  showStaffDetail: boolean;
  /** Item names and categories — financials capability only. */
  showOnboardingItems: boolean;
  documentsHref: string | null;
}) {
  const { current } = cadence;
  // Staff see the Advantage OS module; clients keep the plain label.
  const eyebrow = showStaffDetail ? "Run · Cadence" : "Cadence · Now and next";
  const aside = current ? (
    <span className="text-xs text-muted-soft">
      Phase {current.ordinal} of {cadence.phaseCount}
    </span>
  ) : null;

  // Nothing at all to show: one calm note, never a stack of empty cards.
  if (cadence.phaseCount === 0 && !cadence.phasesFailed && cadence.onboarding === null) {
    return (
      <HomeSection id="home-cadence" eyebrow={eyebrow}>
        <SoftNote title={EMPTY_TITLE} body={showStaffDetail ? EMPTY_STAFF_BODY : EMPTY_CLIENT_BODY} />
      </HomeSection>
    );
  }

  const cards: ReactNode[] = [<PhaseNowCard key="now" cadence={cadence} showStaffDetail={showStaffDetail} />];
  if (cadence.phaseCount > 0 && !cadence.allPhasesComplete && !cadence.phasesFailed && current) {
    cards.push(<PhaseNextCard key="next" cadence={cadence} current={current} />);
  }
  if (cadence.onboarding) {
    cards.push(
      <OnboardingCard
        key="onboarding"
        onboarding={cadence.onboarding}
        showStaffDetail={showStaffDetail}
        showItems={showOnboardingItems}
        documentsHref={documentsHref}
      />
    );
  }

  return (
    <HomeSection id="home-cadence" eyebrow={eyebrow} aside={aside}>
      <div className={`grid gap-4 ${COLS[cards.length] ?? ""}`}>{cards}</div>
    </HomeSection>
  );
}

function PhaseNowCard({ cadence, showStaffDetail }: { cadence: Cadence; showStaffDetail: boolean }) {
  if (cadence.phasesFailed) {
    return <SoftNote title="Phases aren't available right now" body="Your engagement and documents are unaffected." />;
  }
  if (cadence.phaseCount === 0) {
    return <SoftNote title={EMPTY_TITLE} body={showStaffDetail ? EMPTY_STAFF_BODY : EMPTY_CLIENT_BODY} />;
  }
  const c = cadence.current;
  if (cadence.allPhasesComplete || !c) {
    return (
      <div className={CARD}>
        <p className={EYEBROW}>Now</p>
        <h3 className="mt-2 text-base font-bold text-ink">All phases complete</h3>
        <p className="mt-0.5 text-xs text-muted">{plural(cadence.phaseCount, "phase", "phases")} delivered.</p>
      </div>
    );
  }

  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <p className={EYEBROW}>
          {cadence.currentLabel} · Phase {c.ordinal}
        </p>
        {c.statusLabel ? <Pill tone={c.statusTone}>{c.statusLabel}</Pill> : null}
      </div>
      <h3 className="mt-2 text-base font-bold text-ink">{c.name}</h3>
      {c.dateLabel ? <p className="mt-0.5 text-xs text-muted">{c.dateLabel}</p> : null}
      {c.purpose ? <p className="mt-3 line-clamp-3 text-sm text-muted">{c.purpose}</p> : null}

      {cadence.deliverables !== null ? (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-muted-soft">
            <span>{cadence.deliverablesIncludeEarlier ? "Open deliverables (incl. earlier phases)" : "Open deliverables"}</span>
            {c.deliverableTotal > 0 ? (
              <span>
                Phase {c.ordinal}: {c.deliverableDone} of {c.deliverableTotal} delivered
              </span>
            ) : null}
          </div>
          {cadence.deliverables.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {cadence.deliverables.map((d) => (
                <li key={d.id} className="flex items-start justify-between gap-3">
                  <span className="text-sm text-ink">
                    {d.name}
                    {!d.inCurrentPhase ? (
                      <span className="ml-1 text-xs text-muted-soft">· Phase {d.phaseOrdinal}</span>
                    ) : null}
                  </span>
                  {d.dueLabel === null ? null : d.overdue ? (
                    <Pill tone="alert">{d.dueLabel}</Pill>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-soft">{d.dueLabel}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">
              {c.deliverableTotal === 0
                ? "No deliverables listed for this phase yet."
                : "Every deliverable in this phase has been delivered."}
            </p>
          )}
          {cadence.moreDeliverables > 0 ? (
            <p className="mt-2 text-xs text-muted-soft">+{cadence.moreDeliverables} more open</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PhaseNextCard({ cadence, current }: { cadence: Cadence; current: CadencePhase }) {
  const n = cadence.next;
  // On the sequence fallback the current card already says "Up next".
  const nextWord = cadence.currentLabel === "Up next" ? "After that" : "Up next";

  if (!n) {
    return (
      <div className={CARD}>
        <p className={EYEBROW}>{nextWord}</p>
        <p className="mt-2 text-sm text-muted">
          {current.isOngoing ? "This is the ongoing phase." : "Nothing scheduled after this phase."}
        </p>
      </div>
    );
  }

  return (
    <div className={CARD}>
      <p className={EYEBROW}>
        {nextWord} · Phase {n.ordinal}
      </p>
      <h3 className="mt-2 text-base font-bold text-ink">{n.name}</h3>
      {n.dateLabel ? <p className="mt-0.5 text-xs text-muted">{n.dateLabel}</p> : null}
      {n.purpose ? <p className="mt-3 line-clamp-3 text-sm text-muted">{n.purpose}</p> : null}
      {cadence.deliverables !== null && n.deliverableTotal > 0 ? (
        <p className="mt-4 text-xs text-muted-soft">
          {plural(n.deliverableTotal, "deliverable", "deliverables")} planned
        </p>
      ) : null}
    </div>
  );
}

function OnboardingCard({
  onboarding: o,
  showStaffDetail,
  showItems,
  documentsHref,
}: {
  onboarding: CadenceOnboarding;
  showStaffDetail: boolean;
  showItems: boolean;
  documentsHref: string | null;
}) {
  if (o.open === 0) {
    return (
      <div className={CARD}>
        <p className={EYEBROW}>Onboarding</p>
        <p className="mt-2 text-sm text-muted">
          Onboarding complete — all {o.totalIsCapped ? "500+" : o.total} items received or waived.
        </p>
      </div>
    );
  }

  const split = [
    o.openClient > 0 ? `${o.openClient} ${showStaffDetail ? "waiting on client" : "with your team"}` : null,
    o.openGbtn > 0 ? `${o.openGbtn} with GBTN` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(" · ");

  const chips = [
    ["Day 1", o.byPriority.day_1],
    ["Week 1", o.byPriority.week_1],
    ["Week 2", o.byPriority.week_2],
    ["Unscheduled", o.byPriority.unscheduled],
  ] as const;

  return (
    <div className={CARD}>
      <p className={EYEBROW}>Onboarding</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-ink">
        <span className="text-gradient">{o.open}</span>{" "}
        <span className="text-base font-medium text-muted">
          of {o.totalIsCapped ? "500+" : o.total} outstanding
        </span>
      </p>
      {split ? <p className="mt-1 text-xs text-muted-soft">{split}</p> : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chips
          .filter(([, count]) => count > 0)
          .map(([label, count]) => (
            <Pill key={label} tone="neutral">
              {label} · {count}
            </Pill>
          ))}
      </div>

      {showItems ? (
        <>
          <ul className="mt-4 space-y-2.5">
            {o.top.map((t) => (
              <li key={t.id}>
                <p className="text-sm text-ink">{t.item}</p>
                {t.category || t.priorityLabel ? (
                  <p className="mt-0.5 text-xs text-muted-soft">
                    {[t.category, t.priorityLabel].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {o.more > 0 ? <p className="mt-2 text-xs text-muted-soft">+{o.more} more</p> : null}
          {documentsHref ? (
            <Link
              href={documentsHref}
              className="mt-3 inline-block text-xs font-semibold text-brand-700 hover:underline"
            >
              Share files in Documents →
            </Link>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-soft">Your finance lead can see the full request list.</p>
      )}
    </div>
  );
}
