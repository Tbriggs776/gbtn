import type { ReactNode } from "react";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { OpsReportsNav } from "./reports-nav";
import { OrdersUploader } from "./uploader";

/** Shared chrome for every Ops report: header, import button, secondary menu. */
export function OpsShell({
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
        title="Ops Reports"
        subtitle={`${client} · ${subtitle}`}
        actions={<OrdersUploader clientId={clientId} />}
      />
      <div className="mt-4">
        <OpsReportsNav />
      </div>
      <div className="mt-6">{children}</div>
    </PortalShell>
  );
}
