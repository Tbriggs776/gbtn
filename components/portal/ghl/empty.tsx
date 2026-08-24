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

/** Connected, but nothing synced yet. */
export function NoConversationsState() {
  return (
    <EmptyState
      title="Nothing synced yet"
      body="Hit “Sync from GoHighLevel” to pull this year's conversations. The first run reads the whole year and takes a minute or two."
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
