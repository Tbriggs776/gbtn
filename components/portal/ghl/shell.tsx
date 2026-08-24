import type { ReactNode } from "react";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { ConversationsNav } from "./nav";
import { SyncButton } from "./sync-button";

/** Shared chrome for every Conversations view: header, sync button, tabs. */
export function ConversationsShell({
  client,
  clientId,
  subtitle,
  children,
}: {
  client: string;
  clientId: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <PortalShell wide>
      <PortalHeader
        title="Conversations"
        subtitle={`${client} · ${subtitle}`}
        actions={<SyncButton clientId={clientId} />}
      />
      <div className="mt-4">
        <ConversationsNav />
      </div>
      <div className="mt-6">{children}</div>
    </PortalShell>
  );
}
