import type { ReactNode } from "react";

export function PortalHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle ? (
          <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PortalShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 sm:py-10">{children}</div>;
}

export function EmptyState({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-white px-6 py-16 text-center">
      {icon ? (
        <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-paper-soft text-muted">
          {icon}
        </div>
      ) : null}
      <p className="text-base font-semibold text-ink">{title}</p>
      <p className="mt-1.5 max-w-sm text-sm text-muted">{body}</p>
    </div>
  );
}

export function NoClientState({ isAdmin }: { isAdmin: boolean }) {
  return (
    <EmptyState
      title={isAdmin ? "No clients yet" : "Your account isn't linked to a client"}
      body={
        isAdmin
          ? "Create your first client from the Admin area, then invite their team."
          : "Hang tight, Tyler will connect your account to your company shortly."
      }
    />
  );
}
