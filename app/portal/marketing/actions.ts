"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession, getAccessibleClients } from "@/lib/auth";
import { parseRevenueWorkbook } from "@/lib/marketing/revenue-import";
import { loadRevenueImport } from "@/lib/marketing/revenue";

export type MarketingState = { ok?: boolean; error?: string; message?: string };

async function assertMember(clientId: string): Promise<void> {
  await requireSession();
  const clients = await getAccessibleClients();
  if (!clients.some((c) => c.id === clientId)) {
    throw new Error("You don't have access to this client.");
  }
}

export async function loadRevenueAction(
  _prev: MarketingState,
  formData: FormData
): Promise<MarketingState> {
  const clientId = String(formData.get("clientId") ?? "");
  const file = formData.get("file");

  if (!z.string().uuid().safeParse(clientId).success)
    return { error: "Pick a client first." };
  if (!(file instanceof File) || file.size === 0)
    return { error: "Choose a spreadsheet to upload." };

  try {
    await assertMember(clientId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not authorized." };
  }

  let parsed;
  try {
    parsed = parseRevenueWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not parse the spreadsheet." };
  }

  let count;
  try {
    count = await loadRevenueImport(clientId, parsed);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save the data." };
  }

  revalidatePath("/portal/marketing");
  revalidatePath("/portal");
  return {
    ok: true,
    message: `Imported ${count} channel-day row${count === 1 ? "" : "s"} across ${
      parsed.channels.length
    } channel${parsed.channels.length === 1 ? "" : "s"} (${parsed.minDate} → ${parsed.maxDate}).${
      parsed.warnings.length ? " " + parsed.warnings.join(" ") : ""
    }`,
  };
}
