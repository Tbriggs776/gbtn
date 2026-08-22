import { getSession } from "@/lib/auth";
import { CrmTabs } from "./crm-tabs";

// Server wrapper: resolves whether the viewer is a platform admin (only admins
// see the Settings tab, which holds integration credentials) and renders the
// client-side tab bar. Pages keep importing { CrmNav } from this path.
export async function CrmNav() {
  const session = await getSession();
  return <CrmTabs isAdmin={Boolean(session?.isAdmin)} />;
}
