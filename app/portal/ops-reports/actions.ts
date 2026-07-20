"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth";
import { parseOrdersExport } from "@/lib/ops/csv-import";
import { loadOrders } from "@/lib/ops/service";

export type OrdersUploadState = { ok?: boolean; error?: string; message?: string; warnings?: string[] };

// Membership alone is not enough: without the capability check an ops user
// could write marketing data they cannot even read.
async function assertMember(clientId: string): Promise<void> {
  await assertCapability(clientId, "ops");
}

/**
 * Import an RFMS Orders export.
 *
 * The export is a full snapshot, so this REPLACES the client's order lines
 * rather than merging (see loadOrders). One file per import: unlike the Google
 * Ads uploader there's only one report shape here, so there's nothing to route.
 */
export async function uploadOrdersAction(
  _prev: OrdersUploadState,
  formData: FormData
): Promise<OrdersUploadState> {
  const clientId = String(formData.get("clientId") ?? "");
  const file = formData.get("file");

  if (!z.string().uuid().safeParse(clientId).success) return { error: "Pick a client first." };
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an RFMS Orders export to upload." };

  try {
    await assertMember(clientId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }

  try {
    const parsed = parseOrdersExport(Buffer.from(await file.arrayBuffer()));
    const written = await loadOrders(clientId, parsed);

    revalidatePath("/portal/ops-reports/install-pipeline");
    revalidatePath("/portal/ops-reports/orders-pipeline");

    return {
      ok: true,
      message: `Imported ${written.toLocaleString()} lines across ${parsed.cgCount.toLocaleString()} CGs (ordered ${parsed.minOrderDate} → ${parsed.maxOrderDate}).`,
      warnings: parsed.warnings,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "That file could not be read." };
  }
}
