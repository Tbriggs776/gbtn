import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { CrmNav } from "@/components/portal/crm/crm-nav";
import { TasksList } from "@/components/portal/crm/tasks-list";
import { listTasks } from "@/lib/crm/service";

export default async function TasksPage() {
  const db = await createClient();
  const tasks = await listTasks(db, { status: "all", limit: 300 });
  const open = tasks.filter((t) => t.status === "open").length;

  return (
    <PortalShell wide>
      <PortalHeader title="Tasks" subtitle={`${open} open follow-up${open === 1 ? "" : "s"}.`} />
      <CrmNav />
      <TasksList tasks={tasks} />
    </PortalShell>
  );
}
