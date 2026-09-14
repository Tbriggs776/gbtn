import { OFFER_RUNGS, RUNG_LABEL, type OfferRung } from "@/lib/crm/types";
import type { PortalHomeEngagement } from "@/lib/engagements/portal-model";
import { HomeSection, Pill, SoftNote, StaffNote } from "./section";

// Engage: the active engagement and where it sits on the Advantage OS ladder.
// Every client-visible field is identical for every viewer; platform admins get
// muted staff-only lines on top. Nothing from crm_deals or the firm pipeline is
// ever rendered to a client.

const RUNG_CHIP = "rounded-full px-2.5 py-1 text-[11px] font-semibold";
const RUNG_PASSED = "bg-brand-50 text-brand-700";
const RUNG_CURRENT = "bg-ink text-white";
const RUNG_FUTURE = "bg-paper-soft text-muted-soft";

function RungLadder({ rung }: { rung: OfferRung }) {
  const at = OFFER_RUNGS.indexOf(rung);
  return (
    <ol aria-label="Advantage OS rung" className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {OFFER_RUNGS.map((r, i) => (
        <li key={r} className="flex items-center gap-1.5">
          {i > 0 ? (
            <span aria-hidden="true" className="text-xs text-muted-soft">
              →
            </span>
          ) : null}
          <span
            aria-current={i === at ? "step" : undefined}
            className={`${RUNG_CHIP} ${i < at ? RUNG_PASSED : i === at ? RUNG_CURRENT : RUNG_FUTURE}`}
          >
            {RUNG_LABEL[r]}
          </span>
        </li>
      ))}
    </ol>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function EngagementStrip({
  data,
  showStaffDetail,
  clientName,
}: {
  data: PortalHomeEngagement;
  showStaffDetail: boolean;
  clientName: string;
}) {
  return (
    <HomeSection id="home-engagement" eyebrow="Engagement">
      <EngagementBody data={data} showStaffDetail={showStaffDetail} clientName={clientName} />
    </HomeSection>
  );
}

function EngagementBody({
  data,
  showStaffDetail,
  clientName,
}: {
  data: PortalHomeEngagement;
  showStaffDetail: boolean;
  clientName: string;
}) {
  if (data.state === "unavailable") {
    return (
      <SoftNote
        title="Engagement details aren't available right now"
        body="The rest of your home is unaffected."
        detail={
          showStaffDetail ? (
            <p>Engagement query failed (code {data.code ?? "exception"}). Details are in the server logs.</p>
          ) : undefined
        }
      />
    );
  }

  if (data.state === "none") {
    const completed = data.completedCount > 0;
    const staffLines = showStaffDetail
      ? [
          data.schemaMissing ? "engagements table missing (0029)." : null,
          data.hiddenDraftCount > 0
            ? `${plural(data.hiddenDraftCount, "draft engagement", "draft engagements")} hidden from client users.`
            : null,
        ].filter((l): l is string => l !== null)
      : [];
    return (
      <SoftNote
        title={completed ? "No active engagement" : "No active engagement yet"}
        body={
          showStaffDetail
            ? `No open engagement for ${clientName}. Engagements are created from a won deal on the CRM deal board.`
            : completed
              ? "Your previous engagement is complete. Anything new we start together will show here."
              : "When your GBTN engagement is set up, where it sits on the ladder, its timeline and what's happening now will show here."
        }
        detail={staffLines.length > 0 ? staffLines.map((l) => <p key={l}>{l}</p>) : undefined}
        action={showStaffDetail ? { href: "/portal/crm/deals", label: "Open the deal board →" } : null}
      />
    );
  }

  const e = data.engagement;
  const staff = showStaffDetail ? e.staff : null;

  return (
    <div className="rounded-2xl border border-line bg-white p-6 ring-soft">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={e.tone}>{e.statusLabel}</Pill>
            {e.typeLabel ? <span className="text-xs text-muted">{e.typeLabel}</span> : null}
          </div>
          <h3 className="mt-2 text-lg font-bold tracking-tight text-ink">{e.name}</h3>
          {e.timeline ? (
            <p className="mt-1 text-sm text-muted">
              {e.timeline}
              {e.termDay ? ` · day ${e.termDay.day} of ${e.termDay.of}` : ""}
            </p>
          ) : null}
          {data.otherOpenCount > 0 ? (
            <p className="mt-1 text-xs text-muted-soft">
              {plural(data.otherOpenCount, "other open engagement", "other open engagements")} on file
            </p>
          ) : null}
          {staff?.internalName ? (
            <StaffNote>
              Internal name (from CRM deal): &ldquo;{staff.internalName}&rdquo;. Client users see the heading above.
            </StaffNote>
          ) : null}
          {staff?.rawStatus ? (
            <StaffNote>
              Raw status &ldquo;{staff.rawStatus}&rdquo; isn&apos;t mapped. Client users see &ldquo;Open&rdquo;.
            </StaffNote>
          ) : null}
          {staff?.rawType ? (
            <StaffNote>Type &ldquo;{staff.rawType}&rdquo; isn&apos;t client-facing, so it&apos;s hidden.</StaffNote>
          ) : null}
          {showStaffDetail && data.hiddenDraftCount > 0 ? (
            <StaffNote>
              {plural(data.hiddenDraftCount, "draft engagement", "draft engagements")} hidden from client users.
            </StaffNote>
          ) : null}
          {showStaffDetail && data.failed.length > 0 ? (
            <StaffNote>Some cadence data didn&apos;t load ({data.failed.join(", ")}). See server logs.</StaffNote>
          ) : null}
        </div>

        <div className="shrink-0">
          <p className="text-xs text-muted-soft">Advantage OS rung</p>
          {e.rung ? (
            <RungLadder rung={e.rung} />
          ) : (
            <span className="mt-1.5 inline-flex rounded-full border border-dashed border-line px-2.5 py-1 text-[11px] font-semibold text-muted-soft">
              Rung unset
            </span>
          )}
          {!e.rung && showStaffDetail ? (
            <StaffNote>
              {data.rungColumnMissing
                ? "The offer_rung column is missing (0030)."
                : "offer_rung is null on this engagement. There's no rung editor yet, so set it on the row."}
            </StaffNote>
          ) : null}
        </div>
      </div>
    </div>
  );
}
