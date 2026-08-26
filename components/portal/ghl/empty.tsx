import { EmptyState } from "@/components/portal/ui";

/** No GHL connection has been set up for this client yet. */
export function NotConnectedState({ isAdmin }: { isAdmin: boolean }) {
  return (
    <EmptyState
      title="GoHighLevel isn't connected"
      body={
        isAdmin
          ? "Add the sub-account's Location ID and a Private Integration token in Admin → Integrations, then run a sync."
          : "Tyler needs to connect your GoHighLevel account before this section has anything to show."
      }
    />
  );
}

/** Connected, but nothing synced yet. Syncing is automatic (Supabase cron), so
 *  this is a "give it a moment" state, not a "go press a button" one. */
export function NoConversationsState() {
  return (
    <EmptyState
      title="Nothing here yet"
      body="Conversations sync automatically in the background. If this is a brand-new connection, the first pull takes a little while to appear."
    />
  );
}

/** Connected and synced, but the selected date range has no leads in it. */
export function EmptyRangeState({ label }: { label: string }) {
  return (
    <EmptyState
      title={`No leads in ${label.toLowerCase()}`}
      body="Nobody wrote in during this range. Try a wider window — Last 30 days or This month."
    />
  );
}

/** Connected and synced, but the last attempt failed. */
export function SyncErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-crimson/40 bg-crimson/5 px-4 py-3">
      <p className="text-[13px] font-semibold text-crimson">The last GoHighLevel sync failed</p>
      <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-muted">{message}</p>
      <p className="mt-1.5 text-[11.5px] text-muted-soft">
        The numbers below are from the last successful sync, so treat them as stale.
      </p>
    </div>
  );
}
