"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatBytes, formatDate } from "@/lib/format";
import { DOCUMENT_CATEGORIES, type ClientDocument } from "@/lib/types";
import {
  recordDocumentAction,
  getDownloadUrlAction,
  deleteDocumentAction,
} from "@/app/portal/documents/actions";

const BUCKET = "client-files";

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9.\-_]+/g, "_").slice(0, 180);
}

export function DocumentManager({
  clientId,
  documents,
}: {
  clientId: string;
  documents: ClientDocument[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<string>("Financials");
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function uploadFiles(files: FileList | File[]) {
    setError(null);
    setBusy(true);
    const supabase = createClient();
    try {
      for (const file of Array.from(files)) {
        const path = `${clientId}/${crypto.randomUUID()}-${safeName(file.name)}`;
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, file, {
            contentType: file.type || undefined,
            upsert: false,
          });
        if (upErr) {
          setError(`Upload failed: ${upErr.message}`);
          break;
        }
        const res = await recordDocumentAction({
          clientId,
          storagePath: path,
          fileName: file.name,
          byteSize: file.size,
          contentType: file.type || undefined,
          category,
        });
        if (res.error) {
          setError(res.error);
          // Roll back the orphaned object.
          await supabase.storage.from(BUCKET).remove([path]);
          break;
        }
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    }
  }

  async function handleDownload(id: string) {
    const res = await getDownloadUrlAction(id);
    if (res.url) {
      window.open(res.url, "_blank", "noopener,noreferrer");
    } else {
      setError(res.error ?? "Could not generate download link.");
    }
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this document? This can't be undone.")) return;
    startTransition(async () => {
      const res = await deleteDocumentAction(id);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/* Uploader */}
      <div className="rounded-2xl border border-line bg-white p-5 ring-soft">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium text-ink">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100"
          >
            {DOCUMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={`mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragOver
              ? "border-brand-400 bg-brand-50/50"
              : "border-line hover:border-brand-300 hover:bg-paper-soft"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          />
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-brand text-white">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
              <path d="M12 16V4m0 0L8 8m4-4l4 4M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="mt-3 text-sm font-semibold text-ink">
            {busy ? "Uploading…" : "Drop files here or click to upload"}
          </p>
          <p className="mt-1 text-xs text-muted-soft">
            PDF, Excel, images, and more · stored privately
          </p>
        </div>

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </div>

      {/* List */}
      {documents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-12 text-center">
          <p className="text-sm font-semibold text-ink">No documents yet</p>
          <p className="mt-1 text-sm text-muted">
            Uploaded files will appear here, visible to you and Tyler.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-white ring-soft">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper-soft text-xs uppercase tracking-wide text-muted-soft">
              <tr>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Category</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">Size</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">Added</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {documents.map((doc) => (
                <tr key={doc.id} className="hover:bg-paper-soft/60">
                  <td className="max-w-[16rem] truncate px-5 py-3 font-medium text-ink">
                    {doc.file_name}
                  </td>
                  <td className="px-5 py-3">
                    <span className="rounded-full bg-paper-soft px-2.5 py-0.5 text-xs font-medium text-muted">
                      {doc.category}
                    </span>
                  </td>
                  <td className="hidden px-5 py-3 text-muted sm:table-cell">
                    {formatBytes(doc.byte_size)}
                  </td>
                  <td className="hidden px-5 py-3 text-muted sm:table-cell">
                    {formatDate(doc.created_at)}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleDownload(doc.id)}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                      >
                        Download
                      </button>
                      <button
                        onClick={() => handleDelete(doc.id)}
                        disabled={pending}
                        className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
