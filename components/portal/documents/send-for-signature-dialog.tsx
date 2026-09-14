"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { site } from "@/lib/site";
import { humanize } from "@/lib/engagements/portal-model";
import type { ClientDocument } from "@/lib/types";
import {
  isStaffRole,
  sendEligibility,
  type EsignStaffData,
  type SendForSignatureInput,
  type StaffRequestSummary,
} from "@/lib/esign/types";
import {
  sendForSignatureAction,
  type EsignActionState,
} from "@/app/portal/documents/esign-actions";

// Staff-only modal that creates a signature request for one document. The
// server re-checks everything shown here (eligibility, tenancy, uploader, PDF
// bytes); this only keeps staff from filling in a form that will be refused.

const MANUAL = "__manual__";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INPUT =
  "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
const LABEL = "block text-sm font-medium text-ink";

export function SendForSignatureDialog({
  doc,
  staff,
  latest,
  onClose,
  nowIso,
}: {
  doc: ClientDocument;
  staff: EsignStaffData;
  latest: StaffRequestSummary | null;
  /** Parent unmounts the dialog. */
  onClose: () => void;
  nowIso: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const now = useMemo(() => new Date(nowIso), [nowIso]);

  // 1. Document type: fixed once the document is filed as one.
  const typeLocked = doc.doc_type !== null;
  const [documentType, setDocumentType] = useState<string>(() => {
    if (doc.doc_type) return doc.doc_type;
    if (staff.types.some((t) => t.documentType === "msa")) return "msa";
    return staff.types[0]?.documentType ?? "";
  });
  const chosenType = staff.types.find((t) => t.documentType === documentType) ?? null;

  // 2. Engagement: fixed once linked; otherwise preselect the only one awaiting
  //    signature, since that is the one a signed MSA would activate.
  const engagementLocked = doc.engagement_id !== null;
  const [engagementId, setEngagementId] = useState<string>(() => {
    if (doc.engagement_id) return doc.engagement_id;
    const awaiting = staff.engagements.filter((e) => e.status === "pending_signature");
    return awaiting.length === 1 ? awaiting[0].id : "";
  });
  const engagement = staff.engagements.find((e) => e.id === engagementId) ?? null;

  // 3. Signer: a contact with an email on file, or someone typed in by hand.
  const [signerKey, setSignerKey] = useState<string>(
    () => staff.contacts.find((c) => c.email)?.id ?? MANUAL
  );
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [supersede, setSupersede] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EsignActionState | null>(null);

  const uploader = staff.uploaders[doc.uploaded_by ?? ""] ?? null;
  const uploaderIsStaff = isStaffRole(uploader?.role ?? null);
  const uploaderKind = uploaderIsStaff
    ? "GBTN staff"
    : uploader?.role === "client"
      ? "client"
      : "unknown";

  const eligibility = useMemo(
    () => sendEligibility(doc, chosenType, latest, uploader, { replaceOpen: false, now }),
    [doc, chosenType, latest, uploader, now]
  );

  const needsPhone = chosenType?.requireSmsOtp === true;
  const contact = signerKey === MANUAL ? null : staff.contacts.find((c) => c.id === signerKey) ?? null;
  const manualTouched = Boolean(fullName || email || phone);

  let signer: SendForSignatureInput["signer"] | null = null;
  let signerProblem: string | null = null;
  if (signerKey !== MANUAL) {
    if (!contact?.email) signerProblem = "Choose a signer.";
    else if (needsPhone && !contact.phone)
      signerProblem =
        "This contact has no mobile number on file, and this type needs an SMS code. Choose Someone else to enter one.";
    else signer = { kind: "contact", contactId: contact.id };
  } else {
    const n = fullName.trim();
    const em = email.trim();
    const ph = phone.trim();
    if (n.length < 2) signerProblem = "Enter the signer's full name.";
    else if (!EMAIL_RE.test(em)) signerProblem = "Enter a valid email address.";
    else if (needsPhone && ph.length < 7)
      signerProblem = "A mobile number is required because this type needs an SMS code.";
    else signer = { kind: "manual", fullName: n, email: em, ...(needsPhone ? { phone: ph } : {}) };
  }
  const signerName = contact?.full_name ?? fullName.trim();

  const canSend = Boolean(chosenType && signer && eligibility.ok && !pending);

  // Once a link is on screen, only an explicit Done/close dismisses it: the
  // link is shown exactly once. Never close mid-send, or the result is lost.
  const showingLink = Boolean(result?.ok && result.signUrl);
  const close = useCallback(() => {
    if (pending) return;
    if (result?.ok) router.refresh();
    onClose();
  }, [pending, result, router, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showingLink) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, showingLink]);

  function send() {
    if (!chosenType || !signer || !eligibility.ok) return;
    const input: SendForSignatureInput = {
      clientId: staff.clientId,
      documentId: doc.id,
      documentType: chosenType.documentType,
      engagementId: engagementId || null,
      signer,
      supersedeSiblings: Boolean(engagementId) && supersede,
    };
    setError(null);
    startTransition(async () => {
      try {
        const res = await sendForSignatureAction(input);
        if (res.ok) setResult(res);
        else setError(res.error ?? "Something went wrong. Nothing was sent.");
      } catch {
        setError("We couldn't confirm the send. Refresh the page before trying again.");
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:p-8"
      onClick={() => {
        if (!showingLink) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="esign-dialog-title"
        className="w-full max-w-lg rounded-2xl border border-line bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="esign-dialog-title" className="text-base font-bold text-ink">
              Send for signature
            </h2>
            <p className="mt-0.5 truncate text-sm text-muted">{doc.title ?? doc.file_name}</p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={pending}
            aria-label="Close"
            className="rounded-lg p-1 text-muted hover:bg-paper-soft hover:text-ink disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {result?.ok ? (
          <div className="mt-5 space-y-4">
            <p className="rounded-lg bg-paper-soft px-3 py-2 text-sm font-medium text-ink">
              {result.message ?? "Sent for signature."}
            </p>
            {result.signUrl ? <SignLinkPanel url={result.signUrl} signerName={signerName} /> : null}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={close}
                className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            <p
              className={`rounded-lg px-3 py-2 text-xs ${
                uploaderIsStaff ? "bg-paper-soft text-muted" : "bg-amber-50 text-amber-900"
              }`}
            >
              Uploaded by {uploader?.name ?? "unknown"} ({uploaderKind})
            </p>

            {/* 1. Document type */}
            <div>
              <span className={LABEL}>Document type</span>
              {typeLocked ? (
                <p className="mt-1 text-sm text-ink">
                  {chosenType?.label ?? humanize(doc.doc_type) ?? doc.doc_type}
                </p>
              ) : staff.types.length === 0 ? (
                <p className="mt-1 text-sm text-muted">No document types are enabled for e-signature.</p>
              ) : (
                <select
                  aria-label="Document type"
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  disabled={pending}
                  className={`mt-1 ${INPUT}`}
                >
                  {staff.types.map((t) => (
                    <option key={t.documentType} value={t.documentType}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* 2. Engagement */}
            <div>
              <span className={LABEL}>Engagement</span>
              {engagementLocked ? (
                <p className="mt-1 text-sm text-ink">
                  {engagement
                    ? `${engagement.name} · ${humanize(engagement.status) ?? "No status"}`
                    : "Linked engagement"}
                </p>
              ) : (
                <select
                  aria-label="Engagement"
                  value={engagementId}
                  onChange={(e) => setEngagementId(e.target.value)}
                  disabled={pending}
                  className={`mt-1 ${INPUT}`}
                >
                  <option value="">None</option>
                  {staff.engagements.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} · {humanize(e.status) ?? "No status"}
                    </option>
                  ))}
                </select>
              )}
              {chosenType?.activatesEngagement && engagement?.status === "pending_signature" ? (
                <p className="mt-1 text-xs text-muted">Signing will mark this engagement Active.</p>
              ) : null}
            </div>

            {/* 3. Signer */}
            <fieldset disabled={pending}>
              <legend className={LABEL}>Signer</legend>
              <div className="mt-1 space-y-2">
                {staff.contacts.map((c) => (
                  <label
                    key={c.id}
                    className={`flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm ${
                      c.email ? "cursor-pointer text-ink hover:bg-paper-soft" : "text-muted-soft"
                    }`}
                  >
                    <input
                      type="radio"
                      name="esign-signer"
                      value={c.id}
                      checked={signerKey === c.id}
                      disabled={!c.email}
                      onChange={() => setSignerKey(c.id)}
                      className="mt-1"
                    />
                    <span className="min-w-0 break-words">
                      {[c.full_name, c.title, c.email].filter(Boolean).join(" · ")}
                      {c.email ? null : " (no email on file)"}
                    </span>
                  </label>
                ))}
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-paper-soft">
                  <input
                    type="radio"
                    name="esign-signer"
                    value={MANUAL}
                    checked={signerKey === MANUAL}
                    onChange={() => setSignerKey(MANUAL)}
                    className="mt-1"
                  />
                  <span>Someone else</span>
                </label>
              </div>

              {signerKey === MANUAL ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="sm:col-span-2">
                    <span className="text-xs font-medium text-muted">Full name</span>
                    <input
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      maxLength={120}
                      autoComplete="off"
                      className={`mt-1 ${INPUT}`}
                    />
                  </label>
                  <label className={needsPhone ? "" : "sm:col-span-2"}>
                    <span className="text-xs font-medium text-muted">Email</span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      maxLength={254}
                      autoComplete="off"
                      className={`mt-1 ${INPUT}`}
                    />
                  </label>
                  {needsPhone ? (
                    <label>
                      <span className="text-xs font-medium text-muted">Mobile phone</span>
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        maxLength={32}
                        autoComplete="off"
                        className={`mt-1 ${INPUT}`}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}
              {signerProblem && (signerKey !== MANUAL || manualTouched) ? (
                <p className="mt-2 text-xs text-muted">{signerProblem}</p>
              ) : null}
            </fieldset>

            {/* 4. Supersede siblings */}
            {engagementId ? (
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={supersede}
                  onChange={(e) => setSupersede(e.target.checked)}
                  disabled={pending}
                  className="mt-1"
                />
                <span>
                  Mark other unsigned {chosenType?.label ?? "matching"} documents on this engagement as
                  Superseded
                </span>
              </label>
            ) : null}

            {/* 5. Summary */}
            {chosenType ? (
              <p className="text-xs text-muted-soft">
                Link expires in {chosenType.expiryDays} days · SMS code:{" "}
                {chosenType.requireSmsOtp ? "on" : "off"} · The signer receives an email from {site.name}.
              </p>
            ) : null}

            {eligibility.ok ? (
              eligibility.warning ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
                  {eligibility.warning}
                </p>
              ) : null
            ) : (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                {eligibility.reason}
              </p>
            )}
            {error ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{error}</p>
            ) : null}

            {/* 6. Buttons */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={pending}
                className="rounded-full px-4 py-2 text-sm font-semibold text-muted hover:bg-paper-soft hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110 disabled:opacity-60"
              >
                {pending ? "Sending…" : "Send for signature"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The one-time signing link: a read-only field, Copy link, and the warning.
 * Shared by the dialog and the Resend result in the documents table.
 */
export function SignLinkPanel({ url, signerName }: { url: string; signerName: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "manual">("idle");

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
    } catch {
      // Clipboard API unavailable or denied: select the text for Ctrl+C.
      inputRef.current?.select();
      setCopy("manual");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          readOnly
          value={url}
          aria-label="Signing link"
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg border border-line bg-paper-soft px-3 py-2 text-xs text-ink focus:outline-none"
        />
        <button
          type="button"
          onClick={copyLink}
          className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs font-semibold text-brand-700 hover:bg-brand-50"
        >
          {copy === "copied" ? "Copied" : "Copy link"}
        </button>
      </div>
      {copy === "manual" ? <p className="text-xs text-muted">Press Ctrl+C to copy.</p> : null}
      <p className="text-xs font-medium text-red-600">
        Anyone with this link can sign. Share it only with {signerName || "the signer"}. It won&apos;t be
        shown again.
      </p>
    </div>
  );
}
