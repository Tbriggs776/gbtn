import { requireSession } from "@/lib/auth";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { AccountForms } from "@/components/portal/account-form";

export default async function AccountPage() {
  const session = await requireSession();
  return (
    <PortalShell>
      <PortalHeader
        title="Account"
        subtitle="Update your name and password."
      />
      <div className="mt-8">
        <AccountForms
          email={session.user.email ?? ""}
          fullName={session.profile?.full_name ?? ""}
        />
      </div>
    </PortalShell>
  );
}
