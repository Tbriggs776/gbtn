"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DOCUMENT_CATEGORIES } from "@/lib/types";

export type DocActionState = { ok?: boolean; error?: string };

const BUCKET = "client-files";

// Records a documents row after the browser has uploaded the file straight to
// Storage. RLS on `documents` re-checks membership, so a forged client_id fails.
const recordSchema = z.object({
  clientId: z.string().uuid(),
  storagePath: z.string().min(3),
  fileName: z.string().min(1).max(255),
  byteSize: z.number().int().nonnegative(),
  contentType: z.string().max(255).optional(),
  category: z.enum(
    DOCUMENT_CATEGORIES as unknown as [string, ...string[]]
  ),
});

export async function recordDocumentAction(input: {
  clientId: string;
  storagePath: string;
  fileName: string;
  byteSize: number;
  contentType?: string;
  category: string;
}): Promise<DocActionState> {
  const session = await requireSession();
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid upload metadata." };

  const d = parsed.data;
  // Defense in depth: the storage path must live under the claimed client.
  if (!d.storagePath.startsWith(`${d.clientId}/`)) {
    return { error: "Path mismatch." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("documents").insert({
    client_id: d.clientId,
    uploaded_by: session.user.id,
    storage_path: d.storagePath,
    file_name: d.fileName,
    byte_size: d.byteSize,
    content_type: d.contentType ?? null,
    category: d.category,
  });

  if (error) return { error: error.message };
  revalidatePath("/portal/documents");
  revalidatePath("/portal");
  return { ok: true };
}

// Returns a short-lived signed URL for download (private bucket).
export async function getDownloadUrlAction(
  documentId: string
): Promise<{ url?: string; error?: string }> {
  await requireSession();
  const supabase = await createClient();

  const { data: doc, error } = await supabase
    .from("documents")
    .select("storage_path, file_name")
    .eq("id", documentId)
    .single();
  if (error || !doc) return { error: "Not found." };

  const { data, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, 60, { download: doc.file_name });
  if (signErr || !data) return { error: signErr?.message ?? "Could not sign URL." };
  return { url: data.signedUrl };
}

export async function deleteDocumentAction(
  documentId: string
): Promise<DocActionState> {
  await requireSession();
  const supabase = await createClient();

  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, storage_path")
    .eq("id", documentId)
    .single();
  if (error || !doc) return { error: "Not found." };

  // Remove the object first, then the row.
  await supabase.storage.from(BUCKET).remove([doc.storage_path]);
  const { error: delErr } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId);
  if (delErr) return { error: delErr.message };

  revalidatePath("/portal/documents");
  revalidatePath("/portal");
  return { ok: true };
}
