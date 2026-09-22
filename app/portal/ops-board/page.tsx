import { createClient } from "@/lib/supabase/server";
import { PortalHeader, PortalShell } from "@/components/portal/ui";
import { OpsBoard } from "@/components/portal/ops-board/ops-board";
import { parseOpsBoardItem, type OpsBoardItem } from "@/lib/ops-board/types";

export default async function OpsBoardPage() {
  const db = await createClient();
  const { data, error } = await db
    .from("ops_board_items")
    .select(
      "id, title, status, owner, next_action, due_on, source, notes, sort_order, completed_at, created_at, updated_at"
    )
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  const items: OpsBoardItem[] = [];
  if (!error && Array.isArray(data)) {
    for (const row of data) {
      const item = parseOpsBoardItem(row);
      if (item) items.push(item);
    }
  }

  const open = items.filter((item) => item.status !== "done").length;

  return (
    <PortalShell wide>
      <PortalHeader
        title="Ops Board"
        subtitle={
          error
            ? "The board could not be loaded."
            : `${open} open card${open === 1 ? "" : "s"} · Floor Daddy operating work`
        }
      />
      {error ? (
        <p className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error.message || "The board could not be loaded."}
        </p>
      ) : (
        <OpsBoard items={items} />
      )}
    </PortalShell>
  );
}
