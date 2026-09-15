"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { humanize } from "@/lib/engagements/portal-model";
import type { ClientDocument } from "@/lib/types";
import {
  isStaffRole,
  sendEligibility,
  type EnvelopeSummary,
  type EsignStaffData,
  type EsignTypeSummary,
  type PreparedSource,
  type SendEnvelopeInput,
  type SendFieldInput,
  type SendRecipientInput,
  type SnapshotPage,
} from "@/lib/esign/types";
import type { DraftField, DraftRecipient } from "@/lib/esign/detect-fields";
import {
  prepareEnvelopeSourceAction,
  sendEnvelopeAction,
  type SendEnvelopeState,
} from "@/app/portal/documents/esign-actions";
import {
  RecipientsStep,
  hasSmsNumber,
  recipientsProblems,
  withOrders,
  type WizardRecipient,
  type WizardRecipients,
} from "@/components/portal/documents/wizard-recipients-step";
import {
  PlacementStep,
  placedSourcePages,
  placementGate,
  placementWarnings,
} from "@/components/portal/documents/wizard-placement-step";
import { ReviewStep } from "@/components/portal/documents/wizard-review-step";
import { SignLinkPanel } from "@/components/portal/documents/sign-link-panel";

// Staff-only, full-screen wizard that sends one document out as a signature
// envelope. The server re-checks everything shown here (eligibility, tenancy,
// uploader, bytes, page geometry, recipients, fields); this only keeps staff
// from building an envelope that will be refused.

type Step = 1 | 2 | 3;

const INPUT =
  "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100";
const LABEL = "block text-sm font-medium text-ink";
const PREVIEW_ERROR = "We couldn't load a preview. Try again.";
// The footer's reason must match the placement panel: page-box and asset
// failures have no Retry button there, because retrying can't fix them.
const PREVIEW_BLOCKED = "The preview didn't load, so sending is blocked. Retry it on the Place fields step.";
const PREVIEW_BLOCKED_BY_KIND: Record<"generic" | "assets" | "pages", string> = {
  generic: PREVIEW_BLOCKED,
  pages: "This PDF's page boxes are ambiguous, so sending is blocked. Print it to PDF and upload it again.",
  assets: "The PDF preview files are missing from this deploy, so sending is blocked.",
};

const PLACEABLE_SNIFFED = new Set(["application/pdf", "image/png", "image/jpeg"]);

/**
 * The send resolves the mode from the chosen type (resolveSourceMode(type.sealingMode,
 * kind)); the preview must agree, or the server silently swaps the placed boxes
 * for a certificate page, or refuses a placed send with pages_mismatch.
 */
function sourceModeProblem(type: EsignTypeSummary, source: PreparedSource): string | null {
  const restart = `Go back and choose another document type, or set this document's type to ${type.label} and start again.`;
  if (type.sealingMode === "certificate") {
    return source.mode === "certificate"
      ? null
      : `${type.label} documents are signed on a certificate page, but this preview places boxes on the pages. ${restart}`;
  }
  if (source.mode !== "certificate") return null;
  if (PLACEABLE_SNIFFED.has(source.contentTypeSniffed)) {
    return `${type.label} documents are signed in boxes on the pages, but this preview uses a certificate page. ${restart}`;
  }
  if (type.sealingMode === "page") {
    return `${type.label} documents can only be signed on a PDF or an image, and this file is neither.`;
  }
  return null;
}

function toSendRecipient(r: WizardRecipient): SendRecipientInput {
  switch (r.kind) {
    case "client_contact":
      return { key: r.key, kind: "client_contact", order: r.order, contactId: r.contactId };
    case "outside": {
      const phone = r.phone?.trim();
      return {
        key: r.key,
        kind: "outside",
        order: r.order,
        fullName: r.fullName.trim(),
        email: r.email.trim(),
        ...(phone ? { phone } : {}),
      };
    }
    case "staff":
      return { key: r.key, kind: "staff", order: r.order, staffUserId: r.staffUserId };
  }
}

function toSendField(f: DraftField): SendFieldInput {
  return {
    recipientKey: f.recipientKey,
    kind: f.kind,
    page: f.page,
    x_ppm: f.x_ppm,
    y_ppm: f.y_ppm,
    w_ppm: f.w_ppm,
    h_ppm: f.h_ppm,
    required: f.required,
    origin: f.origin,
    detectedLabel: f.detectedLabel,
  };
}

export function SendEnvelopeWizard({
  doc,
  staff,
  latest,
  nowIso,
  clientLegalName,
  onClose,
}: {
  doc: ClientDocument;
  staff: EsignStaffData;
  latest: EnvelopeSummary | null;
  nowIso: string;
  clientLegalName: string;
  /** Parent unmounts the wizard (which destroys the pdf.js sandbox). */
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const [sending, startSend] = useTransition();
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [step, setStep] = useState<Step>(1);

  // Document type: fixed once the document is filed as one.
  const typeLocked = doc.doc_type !== null;
  const [documentType, setDocumentType] = useState<string>(() => {
    if (doc.doc_type) return doc.doc_type;
    if (staff.types.some((t) => t.documentType === "msa")) return "msa";
    return staff.types[0]?.documentType ?? "";
  });
  const chosenType = staff.types.find((t) => t.documentType === documentType) ?? null;

  // Engagement: fixed once linked; otherwise preselect the only one awaiting
  // signature, since that is the one a signed MSA would activate.
  const engagementLocked = doc.engagement_id !== null;
  const [engagementId, setEngagementId] = useState<string>(() => {
    if (doc.engagement_id) return doc.engagement_id;
    const awaiting = staff.engagements.filter((e) => e.status === "pending_signature");
    return awaiting.length === 1 ? awaiting[0].id : "";
  });
  const engagement = staff.engagements.find((e) => e.id === engagementId) ?? null;
  const engagementLabel = engagementId
    ? engagement
      ? `${engagement.name} · ${humanize(engagement.status) ?? "No status"}`
      : "Linked engagement"
    : null;

  // Recipients: start with the first contact that can sign (primary first).
  const [recipients, setRecipientsState] = useState<WizardRecipients>(() => {
    const type = staff.types.find((t) => t.documentType === (doc.doc_type ?? "msa")) ?? staff.types[0] ?? null;
    const c = staff.contacts.find((x) => x.email && (!type?.requireSmsOtp || hasSmsNumber(x.phone)));
    return {
      routing: "parallel",
      list: c
        ? [{ key: "r1", kind: "client_contact", order: 1, contactId: c.id, displayName: c.full_name, email: c.email ?? "" }]
        : [],
    };
  });

  const [source, setSource] = useState<PreparedSource | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [fields, setFields] = useState<DraftField[]>([]);
  const [verified, setVerified] = useState<{ sha256: string; pages: SnapshotPage[] } | null>(null);
  // Set when the placement preview fails, including after it verified; cleared
  // only by a fresh prepare or a successful re-verification.
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewBlockMessage, setPreviewBlockMessage] = useState(PREVIEW_BLOCKED);
  // Bumped per prepare and per type change: a response for an older request is dropped.
  const prepareSeq = useRef(0);
  const [supersede, setSupersede] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendEnvelopeState | null>(null);

  const uploader = staff.uploaders[doc.uploaded_by ?? ""] ?? null;
  const uploaderIsStaff = isStaffRole(uploader?.role ?? null);
  const uploaderKind = uploaderIsStaff ? "GBTN staff" : uploader?.role === "client" ? "client" : "unknown";

  const eligibility = useMemo(
    () => sendEligibility(doc, chosenType, latest, uploader, { replaceOpen: false, now }),
    [doc, chosenType, latest, uploader, now]
  );

  const problems = chosenType ? recipientsProblems(recipients, staff, chosenType) : {};
  const recipientsOk = Boolean(chosenType) && Object.keys(problems).length === 0;
  const firstProblem = Object.values(problems)[0] ?? null;

  const draftRecipients: DraftRecipient[] = useMemo(
    () =>
      recipients.list.map((r) => ({
        key: r.key,
        kind: r.kind,
        name: r.displayName.trim() || r.email.trim() || "Signer",
      })),
    [recipients]
  );

  const placed = source !== null && source.mode !== "certificate";
  const pages = verified?.pages ?? (source && source.mode !== "certificate" ? placedSourcePages(source) : []);
  const gate = placed ? placementGate(fields, draftRecipients, pages) : null;
  const warnings = [
    ...(eligibility.ok && eligibility.warning ? [eligibility.warning] : []),
    ...(placed ? placementWarnings(fields, draftRecipients) : []),
  ];
  const modeProblem = chosenType && source ? sourceModeProblem(chosenType, source) : null;
  const sourceReady =
    source !== null && verified !== null && verified.sha256 === source.sha256 && !previewFailed;
  const canReview = recipientsOk && eligibility.ok && sourceReady && modeProblem === null && gate === null;
  const blockReason = previewFailed ? previewBlockMessage : (modeProblem ?? gate);
  const hasLinks = Boolean(result?.ok);

  function setRecipients(v: WizardRecipients) {
    const next = { routing: v.routing, list: withOrders(v.list, v.routing) };
    setRecipientsState(next);
    // Boxes belong to a recipient key; a removed signer takes their boxes along.
    const keys = new Set(next.list.map((r) => r.key));
    setFields((fs) => (fs.every((f) => keys.has(f.recipientKey)) ? fs : fs.filter((f) => keys.has(f.recipientKey))));
  }

  function changeType(t: string) {
    setDocumentType(t);
    // The source mode depends on the type's sealing mode, so start over. A
    // prepare still in flight was made for the old type and is dropped.
    prepareSeq.current += 1;
    setPreparing(false);
    setPrepareError(null);
    setPreviewFailed(false);
    setSource(null);
    setVerified(null);
    setFields([]);
  }

  async function prepare() {
    if (preparing) return;
    const seq = ++prepareSeq.current;
    const previousSha = source?.sha256 ?? verified?.sha256 ?? null;
    setPrepareError(null);
    setPreviewFailed(false);
    setPreparing(true);
    setSource(null);
    setVerified(null);
    // The chosen type rides along so the server can resolve the preview's mode
    // from it; sourceModeProblem still blocks Send if the preview disagrees.
    const input: Parameters<typeof prepareEnvelopeSourceAction>[0] = {
      clientId: staff.clientId,
      documentId: doc.id,
      ...(chosenType ? { documentType: chosenType.documentType } : {}),
    };
    try {
      const res = await prepareEnvelopeSourceAction(input);
      if (seq !== prepareSeq.current) return;
      if (res.ok && res.source) {
        // Different bytes mean the old boxes may sit on the wrong lines.
        if (previousSha && previousSha !== res.source.sha256) setFields([]);
        setSource(res.source);
        if (res.source.mode === "certificate") setVerified({ sha256: res.source.sha256, pages: [] });
      } else {
        setPrepareError(res.error ?? PREVIEW_ERROR);
      }
    } catch {
      if (seq === prepareSeq.current) setPrepareError(PREVIEW_ERROR);
    } finally {
      if (seq === prepareSeq.current) setPreparing(false);
    }
  }

  function goToPlacement() {
    if (!recipientsOk || !eligibility.ok) return;
    setError(null);
    setStep(2);
    if (!source && !preparing) void prepare();
  }

  function send() {
    if (!chosenType || !source || !verified || !canReview || sending) return;
    const input: SendEnvelopeInput = {
      clientId: staff.clientId,
      documentId: doc.id,
      documentType: chosenType.documentType,
      engagementId: engagementId || null,
      routing: recipients.routing,
      recipients: recipients.list.map(toSendRecipient),
      fields: source.mode === "certificate" ? [] : fields.map(toSendField),
      sourceSha256: verified.sha256,
      pages: verified.pages,
      supersedeSiblings: Boolean(engagementId) && supersede,
      replaceOpen: false,
    };
    setError(null);
    startSend(async () => {
      try {
        const res = await sendEnvelopeAction(input);
        if (res.ok) setResult(res);
        else setError(res.error ?? "Something went wrong. Nothing was sent.");
      } catch {
        setError("We couldn't confirm the send. Refresh the page before trying again.");
      }
    });
  }

  const dirty = fields.length > 0 || step > 1;
  const close = useCallback(() => {
    if (sending) return;
    if (hasLinks) {
      router.refresh();
      onClose();
      return;
    }
    if (dirty && !confirm("Close without sending? Your signers and boxes will be lost.")) return;
    onClose();
  }, [sending, hasLinks, dirty, router, onClose]);

  // Escape closes on steps 1 and 3 only; on step 2 it belongs to the placement
  // tools. Once links are on screen only Done closes: they're shown once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || hasLinks || step === 2) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, hasLinks, step]);

  // Full-screen: keep the page behind from scrolling.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const steps: { n: Step; label: string }[] = [
    { n: 1, label: "Signers" },
    { n: 2, label: source?.mode === "certificate" ? "Signature page" : "Place fields" },
    { n: 3, label: "Review & send" },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="esign-wizard-title"
      className="fixed inset-0 z-50 flex flex-col bg-paper-soft"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-line bg-white px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h2 id="esign-wizard-title" className="text-base font-bold text-ink">
            Send for signature
          </h2>
          <p className="truncate text-sm text-muted">{doc.title ?? doc.file_name}</p>
        </div>
        {hasLinks ? null : (
          <ol className="hidden items-center gap-2 text-xs md:flex">
            {steps.map((s, i) => (
              <li key={s.n} className="flex items-center gap-2">
                {i > 0 ? <span className="h-px w-6 bg-line" aria-hidden="true" /> : null}
                <span
                  aria-current={step === s.n ? "step" : undefined}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold ${
                    step === s.n ? "bg-brand-50 text-brand-700" : step > s.n ? "text-ink" : "text-muted-soft"
                  }`}
                >
                  <span className="grid h-5 w-5 place-items-center rounded-full border border-current text-[10px]">
                    {s.n}
                  </span>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        )}
        <button
          type="button"
          onClick={close}
          disabled={sending || hasLinks}
          aria-label="Close"
          className="rounded-lg p-1 text-muted hover:bg-paper-soft hover:text-ink disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Body */}
      {hasLinks && result ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-2xl space-y-4">
            <p className="rounded-lg bg-white px-4 py-3 text-sm font-medium text-ink ring-soft">
              {result.message ?? "Sent for signature."}
            </p>
            <ul className="space-y-3">
              {(result.links ?? []).map((l) => (
                <li key={l.recipientId} className="rounded-xl border border-line bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{l.name}</p>
                      <p className="break-all text-xs text-muted">{l.email}</p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        l.url === null
                          ? "bg-paper-soft text-muted"
                          : l.emailed
                            ? "bg-emerald-50 text-emerald-800"
                            : "bg-red-50 text-red-700"
                      }`}
                    >
                      {l.url === null
                        ? "Will be emailed when it's their turn"
                        : l.emailed
                          ? "Emailed"
                          : "Email failed — copy the link"}
                    </span>
                  </div>
                  {l.url ? (
                    <div className="mt-3">
                      <SignLinkPanel url={l.url} signerName={l.name} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {/* Step 1 */}
          <div hidden={step !== 1} className="h-full overflow-y-auto px-4 py-6 sm:px-6">
            <div className="mx-auto max-w-2xl space-y-5">
              <p
                className={`rounded-lg px-3 py-2 text-xs ${
                  uploaderIsStaff ? "bg-white text-muted" : "bg-amber-50 text-amber-900"
                }`}
              >
                Uploaded by {uploader?.name ?? "unknown"} ({uploaderKind})
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
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
                      onChange={(e) => changeType(e.target.value)}
                      disabled={sending}
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
                <div>
                  <span className={LABEL}>Engagement</span>
                  {engagementLocked ? (
                    <p className="mt-1 text-sm text-ink">{engagementLabel}</p>
                  ) : (
                    <select
                      aria-label="Engagement"
                      value={engagementId}
                      onChange={(e) => setEngagementId(e.target.value)}
                      disabled={sending}
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
                    <p className="mt-1 text-xs text-muted">Completing this marks the engagement Active.</p>
                  ) : null}
                </div>
              </div>

              {eligibility.ok ? null : (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{eligibility.reason}</p>
              )}

              {chosenType ? (
                <RecipientsStep
                  staff={staff}
                  type={chosenType}
                  value={recipients}
                  onChange={setRecipients}
                  disabled={sending}
                />
              ) : null}
            </div>
          </div>

          {/* Step 2 */}
          <div hidden={step !== 2} className="h-full">
            {source && source.mode !== "certificate" ? (
              <PlacementStep
                source={source}
                recipients={draftRecipients}
                clientLegalName={clientLegalName}
                fields={fields}
                onFieldsChange={setFields}
                onVerified={(v) => {
                  setVerified(v);
                  setPreviewFailed(false);
                }}
                onInvalidated={(kind) => {
                  setVerified(null);
                  setPreviewBlockMessage(PREVIEW_BLOCKED_BY_KIND[kind]);
                  setPreviewFailed(true);
                }}
                disabled={sending || step !== 2}
                onReloadSource={() => void prepare()}
              />
            ) : (
              <div className="h-full overflow-y-auto px-4 py-6 sm:px-6">
                <div className="mx-auto max-w-2xl">
                  {preparing ? (
                    <p className="py-16 text-center text-sm text-muted">Checking the file…</p>
                  ) : prepareError ? (
                    <div className="rounded-xl border border-red-200 bg-white p-5 text-center">
                      <p className="text-sm font-medium text-red-700">{prepareError}</p>
                      <button
                        type="button"
                        onClick={() => void prepare()}
                        className="mt-3 rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-brand-700 hover:bg-brand-50"
                      >
                        Retry
                      </button>
                    </div>
                  ) : source?.mode === "certificate" ? (
                    <div className="space-y-3 rounded-xl border border-line bg-white p-5 text-sm text-ink">
                      <p>
                        This file can&apos;t carry signature boxes. Signers sign a certificate page bound to this exact
                        file, and the file is attached to the sealed copy.
                      </p>
                      <p className="text-xs text-muted">
                        {source.fileName} · {source.extension.replace(/^\./, "").toUpperCase()} ·{" "}
                        {source.contentTypeSniffed}
                      </p>
                      <p className="break-all font-mono text-[11px] text-muted-soft">SHA-256 {source.sha256}</p>
                      {modeProblem ? (
                        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{modeProblem}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          {/* Step 3 */}
          <div hidden={step !== 3} className="h-full overflow-y-auto px-4 py-6 sm:px-6">
            <div className="mx-auto max-w-2xl">
              {step === 3 && chosenType && source ? (
                <ReviewStep
                  doc={doc}
                  type={chosenType}
                  recipients={recipients}
                  source={source}
                  fields={fields}
                  engagementLabel={engagementLabel}
                  supersede={supersede}
                  onSupersedeChange={setSupersede}
                  warnings={warnings}
                  sending={sending}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-line bg-white px-4 py-3 sm:px-6">
        {error ? (
          <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{error}</p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted">
            {hasLinks
              ? "Copy any link you need now. They won't be shown again."
              : step === 1
                ? chosenType && !recipientsOk && recipients.list.length > 0
                  ? firstProblem
                  : null
                : step === 2 || !canReview
                  ? blockReason
                  : null}
          </p>
          <div className="flex items-center gap-2">
            {hasLinks ? (
              <button
                type="button"
                onClick={close}
                className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110"
              >
                Done
              </button>
            ) : (
              <>
                {step === 1 ? (
                  <button
                    type="button"
                    onClick={close}
                    disabled={sending}
                    className="rounded-full px-4 py-2 text-sm font-semibold text-muted hover:bg-paper-soft hover:text-ink disabled:opacity-50"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
                    disabled={sending}
                    className="rounded-full px-4 py-2 text-sm font-semibold text-muted hover:bg-paper-soft hover:text-ink disabled:opacity-50"
                  >
                    Back
                  </button>
                )}
                {step === 1 ? (
                  <button
                    type="button"
                    onClick={goToPlacement}
                    disabled={!recipientsOk || !eligibility.ok}
                    className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110 disabled:opacity-60"
                  >
                    Next
                  </button>
                ) : step === 2 ? (
                  <button
                    type="button"
                    onClick={() => canReview && setStep(3)}
                    disabled={!canReview}
                    className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110 disabled:opacity-60"
                  >
                    Review
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={send}
                    disabled={!canReview || sending}
                    className="bg-gradient-brand inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ring-soft transition-all hover:brightness-110 disabled:opacity-60"
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
