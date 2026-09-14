"use client";

import { Fragment, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatBytes, formatDate, relativeTime } from "@/lib/format";
import { DOCUMENT_CATEGORIES, type ClientDocument } from "@/lib/types";
import { Pill } from "@/components/portal/home/section";
import {
  documentStatusLabel,
  effectiveStatus,
  esignStatusLabel,
  esignStatusTone,
  isOpenStatus,
  sendEligibility,
  type EsignStaffData,
  type StaffRequestSummary,
} from "@/lib/esign/types";
import {
  recordDocumentAction,
  getDownloadUrlAction,
  deleteDocumentAction,
} from "@/app/portal/documents/actions";
import {
  getSignedCopyUrlAction,
  resendSignatureRequestAction,
  voidSignatureRequestAction,
} from "@/app/portal/documents/esign-actions";
import {
  SendForSignatureDialog,
  SignLinkPanel,
} from "@/components/portal/documents/send-for-signature-dialog";

const BUCKET = "client-files";

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9.\-_]+/g, "_").slice(0, 180);
}

/** Whether any enabled type can send this document; else the reason to show. */
function sendOption(
  doc: ClientDocument,
  staff: EsignStaffData,
  latest: StaffRequestSummary | null,
  now: Date
): { ok: true } | { ok: false; reason: string } {
  const uploader = staff.uploaders[doc.uploaded_by ?? ""] ?? null;
  const opts = { replaceOpen: false, now };
  if (staff.types.some((t) => sendEligibility(doc, t, latest, uploader, opts).ok)) {
    return { ok: true };
  }
  const type = staff.types.find((t) => t.documentType === doc.doc_type) ?? staff.types[0] ?? null;
  const r = sendEligibility(doc, type, latest, uploader, opts);
  return { ok: false, reason: r.ok ? "This document can't be sent for signature." : r.reason };
}

export function DocumentManager({
  clientId,
  documents,
  canUploadFinancials = true,
  staff = null,
  nowIso,
}: {
  clientId: string;
  documents: ClientDocument[];
  /** Roles without the financials capability can't file into that category —
      RLS would reject the insert, so don't offer it. */
  canUploadFinancials?: boolean;
  /** Non-null only for GBTN staff whose e-sign reads all succeeded. It is the
      only switch for the e-sign controls; clients see status + Signed copy. */
  staff?: EsignStaffData | null;
  /** Server render time. Every label and eligibility call uses it, so the
      server and client render agree. */
  nowIso: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<string>(
    canUploadFinancials ? "Financials" : "Other"
  );
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  // The dialog keeps the row it was opened on, so a refresh behind it (the
  // send revalidates this page) can't swap its inputs mid-flow.
  const [dialog, setDialog] = useState<{
    doc: ClientDocument;
    latest: StaffRequestSummary | null;
    staff: EsignStaffData;
  } | null>(null);
  // Void / Resend outcome, shown in a row under the document it belongs to.
  const [notice, setNotice] = useState<{
    docId: string;
    message: string;
    signUrl?: string;
    signerName: string;
  } | null>(null);

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

  // The sealed PDF from the esign bucket — never the client-files copy.
  async function handleSignedCopy(id: string) {
    setError(null);
    try {
      const res = await getSignedCopyUrlAction(id);
      if (res.url) {
        window.open(res.url, "_blank", "noopener,noreferrer");
      } else {
        setError(res.error ?? "Could not generate the signed copy link.");
      }
    } catch {
      setError("Could not generate the signed copy link.");
    }
  }

  // Transport failures reject outside the actions' own try/catch. There is no
  // error.tsx, so an uncaught rejection in a transition would blank the page.
  function handleDelete(id: string) {
    if (!confirm("Delete this document? This can't be undone.")) return;
    startTransition(async () => {
      try {
        const res = await deleteDocumentAction(id);
        if (res.error) setError(res.error);
        else router.refresh();
      } catch {
        setError("We couldn't confirm that. Refresh the page before trying again.");
      }
    });
  }

  function handleVoid(doc: ClientDocument, latest: StaffRequestSummary) {
    if (!staff) return;
    if (
      !confirm(
        `Void the signature request sent to ${latest.signerEmail}? The link stops working immediately.`
      )
    )
      return;
    const reason = prompt("Reason for voiding (optional):", "");
    if (reason === null) return;
    const target = staff.clientId;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const res = await voidSignatureRequestAction({
          clientId: target,
          requestId: latest.id,
          reason: reason.trim().slice(0, 500) || undefined,
        });
        if (res.ok) {
          setNotice({
            docId: doc.id,
            message: res.message ?? "Request voided.",
            signerName: latest.signerName,
          });
        } else {
          setError(res.error ?? "Something went wrong. Refresh and try again.");
        }
      } catch {
        setError("We couldn't confirm that. Refresh the page before trying again.");
      } finally {
        // The action revalidates on every outcome; pick up the new state.
        router.refresh();
      }
    });
  }

  function handleResend(doc: ClientDocument, latest: StaffRequestSummary) {
    if (!staff) return;
    if (!confirm("This withdraws the current link and emails a new one.")) return;
    const target = staff.clientId;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        const res = await resendSignatureRequestAction({
          clientId: target,
          requestId: latest.id,
        });
        if (res.ok) {
          setNotice({
            docId: doc.id,
            message: res.message ?? "Sent for signature.",
            signUrl: res.signUrl,
            signerName: latest.signerName,
          });
        } else {
          setError(res.error ?? "Something went wrong. Nothing was sent.");
        }
      } catch {
        setError("We couldn't confirm the send. Refresh the page before trying again.");
      } finally {
        router.refresh();
      }
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
            {DOCUMENT_CATEGORIES.filter(
              (c) => canUploadFinancials || c !== "Financials"
            ).map((c) => (
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
        <div className="overflow-x-auto rounded-2xl border border-line bg-white ring-soft">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-paper-soft text-xs uppercase tracking-wide text-muted-soft">
              <tr>
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Category</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">Size</th>
                <th className="hidden px-5 py-3 font-medium sm:table-cell">Added</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {documents.map((doc) => {
                const docStatus = documentStatusLabel(doc, now);
                const latest = staff?.latestByDocument[doc.id] ?? null;
                const eff = latest ? effectiveStatus(latest, now) : null;
                const open = eff !== null && isOpenStatus(eff);
                const canResend = open || eff === "expired";
                // Rows that can never be sent (signed, superseded, Financials) get no
                // button at all; other ineligible rows keep a disabled one whose
                // tooltip says what to fix.
                const neverSendable =
                  Boolean(doc.signed_at) || doc.status === "superseded" || doc.category === "Financials";
                const send = staff && !open && !neverSendable ? sendOption(doc, staff, latest, now) : null;
                const hasEsignRecords = Boolean(doc.signature_request_id || doc.signed_at);

                return (
                  <Fragment key={doc.id}>
                    <tr className="hover:bg-paper-soft/60">
                      <td className="max-w-[16rem] px-5 py-3">
                        <p className="truncate font-medium text-ink">{doc.title ?? doc.file_name}</p>
                        {doc.title ? (
                          <p className="truncate text-xs text-muted-soft">{doc.file_name}</p>
                        ) : null}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {docStatus ? <Pill tone={docStatus.tone}>{docStatus.label}</Pill> : null}
                          {latest && eff ? (
                            <span
                              title={`to ${latest.signerEmail} · sent ${relativeTime(latest.sentAt)}`}
                              suppressHydrationWarning
                            >
                              <Pill tone={esignStatusTone(eff)}>{esignStatusLabel(eff)}</Pill>
                            </span>
                          ) : null}
                        </div>
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
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <button
                            onClick={() => handleDownload(doc.id)}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                          >
                            Download
                          </button>
                          {doc.signed_at && doc.signature_request_id ? (
                            <button
                              onClick={() => handleSignedCopy(doc.id)}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                            >
                              Signed copy
                            </button>
                          ) : null}
                          {staff && send ? (
                            send.ok ? (
                              <button
                                onClick={() => {
                                  setNotice(null);
                                  setDialog({ doc, latest, staff });
                                }}
                                disabled={pending}
                                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                              >
                                Send for signature
                              </button>
                            ) : (
                              <span title={send.reason}>
                                <button
                                  disabled
                                  className="cursor-not-allowed rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-soft"
                                >
                                  Send for signature
                                </button>
                              </span>
                            )
                          ) : null}
                          {staff && latest && open ? (
                            <button
                              onClick={() => handleVoid(doc, latest)}
                              disabled={pending}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                            >
                              Void
                            </button>
                          ) : null}
                          {staff && latest && canResend ? (
                            <button
                              onClick={() => handleResend(doc, latest)}
                              disabled={pending}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-50"
                            >
                              Resend
                            </button>
                          ) : null}
                          {hasEsignRecords ? null : (
                            <button
                              onClick={() => handleDelete(doc.id)}
                              disabled={pending}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {notice && notice.docId === doc.id ? (
                      <tr className="bg-paper-soft/60">
                        <td colSpan={6} className="px-5 py-4">
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-sm font-medium text-ink">{notice.message}</p>
                            <button
                              onClick={() => setNotice(null)}
                              className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-white hover:text-ink"
                            >
                              Dismiss
                            </button>
                          </div>
                          {notice.signUrl ? (
                            <div className="mt-3 max-w-xl">
                              <SignLinkPanel url={notice.signUrl} signerName={notice.signerName} />
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog ? (
        <SendForSignatureDialog
          doc={dialog.doc}
          staff={dialog.staff}
          latest={dialog.latest}
          nowIso={nowIso}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
