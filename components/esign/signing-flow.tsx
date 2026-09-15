"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AdoptSignatureModal,
  type AdoptedSignature,
} from "@/components/esign/adopt-signature-modal";
import {
  CertificateReview,
  OriginalFileCard,
} from "@/components/esign/certificate-review";
import {
  DocumentFieldsView,
  ESIGN_CARD as card,
  ESIGN_EYEBROW as eyebrow,
  ESIGN_PRIMARY_BTN as primaryBtn,
  ESIGN_QUIET_BTN as quietBtn,
  ESIGN_SECONDARY_BTN as secondaryBtn,
  esignFieldDomId,
  postEsign as post,
  postSeal,
} from "@/components/esign/document-fields-view";
import { TypedSignaturePreview } from "@/components/esign/typed-signature-preview";
import { site } from "@/lib/site";
import {
  normalizeSignerText,
  type EsignApiError,
  type EsignErrorCode,
  type SigningView,
  type SubmitSignature,
  type ViewField,
} from "@/lib/esign/types";

// Public signing flow for one recipient of an envelope. The token is the only
// credential: every call is a POST carrying it, and nothing is sent on mount —
// "viewed" is recorded only when the signer clicks Review (so mail scanners that
// fetch the page leave no evidence). A verified-phone otpSession lives in React
// state only, never storage; a reload means verifying again. Every value from
// the snapshot renders as React text; raw HTML injection is never used.
//
// Signing: adopt a signature once (draw or type), then tap each of your
// signature boxes; each tap is per-box intent and its id is what the server
// stamps into (addendum S5). Submit never seals: when the last signature lands
// the page asks /api/esign/seal to build the executed copy (C11).

type OpenView = Extract<SigningView, { state: "open" }>;
type ClosedView = Extract<SigningView, { state: "invalid" | "expired" | "voided" | "declined" }>;
type Busy = null | "view" | "source" | "send_otp" | "verify" | "submit" | "decline";
type Area = "review" | "source" | "otp" | "sign" | "decline";
type Flash = { area: Area; tone: "error" | "info"; text: string };
type SealPhase = "idle" | "preparing" | "slow";

const GENERIC = "Something went wrong. Please try again.";
// The server's OTP cooldown is 60 s. Never make the signer wait longer than
// that on the strength of a client clock that may be skewed; the server still
// answers otp_cooldown if they are early.
const RESEND_WAIT_CAP_MS = 60_000;
const SEAL_POLL_MS = 5_000;
const SEAL_POLL_WINDOW_MS = 120_000;
const SEAL_REPOST_MS = 30_000;
const BUSY_AREA: Record<Exclude<Busy, null>, Area> = {
  view: "review",
  source: "source",
  send_otp: "otp",
  verify: "otp",
  submit: "sign",
  decline: "decline",
};
const SIGN_FORM_ID = "esign-sign-form";
const OTP_SECTION_ID = "esign-otp-section";

const MESSAGES: Partial<Record<EsignErrorCode, string>> = {
  bad_request:
    "Something in the form isn't right. Check your name and signature, then try again.",
  unsupported_media_type: "Something went wrong. Refresh the page and try again.",
  forbidden_origin: "Something went wrong. Refresh the page and try again.",
  payload_too_large: "Your signature image is too large. Change it and sign again.",
  not_found: "This signing link isn't valid.",
  expired: "This signing link has expired.",
  closed: "This signing request is no longer open.",
  already_signed: "You've already signed this document.",
  document_changed:
    "This document changed after it was sent. GBTN has been notified and will send a new link.",
  signature_invalid: "We couldn't read your signature. Change it and sign again.",
  otp_required: "Your verification expired. Request a new code.",
  otp_not_required: "This document doesn't need a text code.",
  otp_incorrect: "That code isn't right.",
  otp_code_expired: "That code has expired. Request a new one.",
  otp_locked: "Too many attempts. Request a new code.",
  otp_cooldown: "A code was just sent. You can request another shortly.",
  otp_limit: "Too many codes sent. Contact GBTN.",
  sms_failed: "We couldn't text your phone. Contact GBTN.",
  download_expired: "The download window has closed. Ask GBTN for a copy.",
  typed_unsupported:
    "Your name has characters the typed style can't show. Draw your signature instead.",
  name_unsupported:
    "Your printed name has characters we can't print on the signed copy. Type it with standard letters.",
  fields_incomplete: "Tap every required Sign box before submitting.",
  out_of_order: "It's not your turn yet. We'll email you when it is.",
  staff_session_required:
    "Sign in to the GBTN portal as yourself in this browser, then try again.",
  not_active: "Your link isn't active yet. We'll email you when it's your turn.",
};

// Codes that mean our picture of the envelope is stale: re-read it with `get`
// and render whatever the server now says.
const RECOVER = new Set<EsignErrorCode>([
  "already_signed",
  "closed",
  "server_error",
  "expired",
  "not_found",
  "document_changed",
  "otp_not_required",
  "out_of_order",
  "not_active",
]);

function messageFor(err: EsignApiError): string {
  // not_available carries a specific server sentence ("still being prepared").
  if (err.code === "not_available") return err.message || "That file isn't available right now.";
  return MESSAGES[err.code] ?? (err.message || GENERIC);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.length > 0 && tz.length <= 64 ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

function byPosition(a: ViewField, b: ViewField): number {
  return a.page - b.page || a.y_ppm - b.y_ppm || a.x_ppm - b.x_ppm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function focusById(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

// Dates render in Arizona time, assembled from parts so the server and the
// browser produce identical text (ICU builds disagree on the space before
// AM/PM, which would break hydration).
const PHOENIX = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Phoenix",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function phoenixParts(iso: string): Record<string, string> | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const part of PHOENIX.formatToParts(d)) parts[part.type] = part.value;
  return parts;
}

function formatPhoenix(iso: string): string {
  const p = phoenixParts(iso);
  if (!p) return "—";
  return `${p.month} ${p.day}, ${p.year} at ${p.hour}:${p.minute} ${p.dayPeriod ?? ""} ${p.timeZoneName ?? ""}`.trim();
}

function formatPhoenixTime(iso: string): string {
  const p = phoenixParts(iso);
  if (!p) return "";
  return `${p.hour}:${p.minute} ${p.dayPeriod ?? ""} ${p.timeZoneName ?? ""}`.trim();
}

// Consent paragraphs split on blank lines; single line breaks survive through
// whitespace-pre-line.
function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

const docCard = "rounded-2xl border border-line bg-white p-3 sm:p-6";
const labelCls = "mb-1.5 block text-sm font-medium text-ink";
const field =
  "w-full rounded-md border border-line bg-white px-4 py-3 text-sm text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-paper-soft";
const codeField =
  "w-40 rounded-md border border-line bg-white px-3 py-2.5 text-center text-lg tracking-[0.3em] text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100";
const dangerBtn =
  "inline-flex items-center justify-center rounded-md border border-crimson/40 bg-white px-4 py-2.5 text-sm font-semibold text-crimson transition-colors hover:bg-crimson/5 disabled:cursor-not-allowed disabled:opacity-50";

function FlashLine({ flash, area }: { flash: Flash | null; area: Area }) {
  if (!flash || flash.area !== area) return null;
  return flash.tone === "error" ? (
    <p role="alert" className="mt-3 text-sm text-red-600">
      {flash.text}
    </p>
  ) : (
    <p role="status" className="mt-3 text-sm text-brand-700">
      {flash.text}
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-ink sm:text-right">
        {children}
      </dd>
    </div>
  );
}

function CheckBadge() {
  return (
    <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-50 text-navy">
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
        <path
          d="M5 12.5l4.5 4.5L19 7.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function SigningFlow({
  token,
  initial,
}: {
  token: string;
  initial: SigningView;
}) {
  const [view, setView] = useState<SigningView>(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [selfDeclined, setSelfDeclined] = useState(false);
  const [sealPhase, setSealPhase] = useState<SealPhase>("idle");
  const alive = useRef(true);
  const sealRun = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sealRun.current += 1;
    };
  }, []);

  function applyView(next: SigningView) {
    if (next.state !== "completing") {
      sealRun.current += 1; // stops any sealing poll
      setSealPhase("idle");
    }
    setView(next);
  }

  // After THIS browser's submit completed the envelope: ask the seal route to
  // build the executed copy now, poll `get` every 5 s for up to 2 minutes, and
  // re-ask at most every 30 s. The seal route holds a lease, so overlapping
  // calls from other signers are harmless.
  function startSealing() {
    const run = ++sealRun.current;
    setSealPhase("preparing");
    const started = Date.now();
    let lastSeal = 0;
    let sealInflight = false;
    let finished = false;
    const current = () => alive.current && sealRun.current === run && !finished;
    const settle = (next: SigningView) => {
      if (!current() || next.state === "completing") return;
      finished = true;
      applyView(next);
    };
    const fireSeal = () => {
      if (sealInflight) return;
      sealInflight = true;
      lastSeal = Date.now();
      postSeal(token)
        .then((r) => {
          if (r.ok) settle(r.data);
        })
        .catch(() => undefined)
        .finally(() => {
          sealInflight = false;
        });
    };
    fireSeal();
    void (async () => {
      try {
        while (current() && Date.now() - started < SEAL_POLL_WINDOW_MS) {
          await sleep(SEAL_POLL_MS);
          if (!current()) return;
          const g = await post({ action: "get", token });
          if (!current()) return;
          if (g.ok) {
            settle(g.data);
            if (finished) return;
          }
          if (!sealInflight && Date.now() - lastSeal >= SEAL_REPOST_MS) fireSeal();
        }
        if (current()) setSealPhase("slow");
      } catch {
        if (current()) setSealPhase("slow");
      }
    })();
  }

  function handleSubmitted(next: SigningView) {
    applyView(next);
    if (next.state === "completing") startSealing();
  }

  function handleDeclined(next: SigningView) {
    if (next.state === "declined") setSelfDeclined(true);
    applyView(next);
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      {notice ? (
        <p
          role="alert"
          className="rounded-xl border border-crimson/30 bg-white px-4 py-3 text-sm text-crimson"
        >
          {notice}
        </p>
      ) : null}
      {view.state === "open" ? (
        <OpenFlow
          token={token}
          view={view}
          onView={applyView}
          onSubmitted={handleSubmitted}
          onDeclined={handleDeclined}
          onNotice={setNotice}
        />
      ) : view.state === "signed_waiting" ? (
        <SignedWaitingCard token={token} view={view} onView={applyView} />
      ) : view.state === "completing" ? (
        <CompletingCard token={token} view={view} phase={sealPhase} onView={applyView} />
      ) : view.state === "completed" ? (
        <CompletedCard token={token} view={view} onView={applyView} />
      ) : (
        <ClosedCard view={view} selfDeclined={selfDeclined} />
      )}
    </div>
  );
}

function ClosedCard({ view, selfDeclined }: { view: ClosedView; selfDeclined: boolean }) {
  let heading: string;
  let body: string;
  let title: string | null = null;
  switch (view.state) {
    case "expired":
      heading = "This signing link has expired.";
      body = "Contact GBTN for a new link.";
      title = view.title;
      break;
    case "voided":
      heading = "This request was withdrawn.";
      body = "If you still need to sign, GBTN will send you a new link.";
      title = view.title;
      break;
    case "declined":
      if (selfDeclined) {
        heading = `You declined to sign ${view.title}.`;
        body = "GBTN has been notified, and signing is canceled for everyone.";
      } else {
        heading = "Signing was declined.";
        title = view.title;
        body =
          "A signer declined, so this document is no longer out for signature. GBTN has been notified.";
      }
      break;
    default:
      heading = "This signing link isn't valid.";
      body =
        "Check you opened the full link from your email, or ask GBTN for a new one.";
  }
  return (
    <section className={`${card} text-center`}>
      <h1 className="text-xl font-bold tracking-tight text-ink">{heading}</h1>
      {title ? (
        <p className="mt-1 text-sm font-medium text-ink">{title}</p>
      ) : null}
      <p className="mt-2 text-sm text-muted">{body}</p>
    </section>
  );
}

function SignedWaitingCard({
  token,
  view,
  onView,
}: {
  token: string;
  view: Extract<SigningView, { state: "signed_waiting" }>;
  onView: (v: SigningView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function check() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await post({ action: "get", token });
      if (!r.ok) {
        setMessage(messageFor(r.error));
      } else if (r.data.state !== "signed_waiting") {
        onView(r.data);
      } else {
        onView(r.data);
        setMessage("Still waiting on the other signers.");
      }
    } catch {
      setMessage(GENERIC);
    } finally {
      setBusy(false);
    }
  }

  const others =
    view.remaining === 1
      ? "the other signer signs"
      : view.remaining > 1
        ? `the other ${view.remaining} signers sign`
        : "the other signers sign";

  return (
    <section className={`${card} text-center`}>
      <CheckBadge />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">
        Signed. Thank you.
      </h1>
      <p className="mt-1 text-sm font-medium text-ink">{view.title}</p>
      <p className="mt-2 text-sm text-muted">
        We&apos;ll email the executed copy to {view.emailMasked} when {others}.
      </p>
      <p className="mt-1 text-xs text-muted-soft">
        You signed {formatPhoenix(view.signedAt)}
      </p>
      <button type="button" onClick={check} disabled={busy} className={`${quietBtn} mt-5`}>
        {busy ? "Checking…" : "Check status"}
      </button>
      {message ? (
        <p role="status" className="mt-2 text-sm text-muted">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function CompletingCard({
  token,
  view,
  phase,
  onView,
}: {
  token: string;
  view: Extract<SigningView, { state: "completing" }>;
  phase: SealPhase;
  onView: (v: SigningView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // One seal request per click; an SSR-rendered "completing" page never posts
  // on its own.
  async function check() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await postSeal(token);
      if (!r.ok) {
        setMessage(messageFor(r.error));
      } else if (r.data.state !== "completing") {
        onView(r.data);
      } else {
        setMessage("Still being prepared. Check again in a minute.");
      }
    } catch {
      setMessage(GENERIC);
    } finally {
      setBusy(false);
    }
  }

  const preparing = phase === "preparing";
  return (
    <section className={`${card} text-center`}>
      {preparing ? (
        <div
          aria-hidden="true"
          className="mx-auto h-12 w-12 animate-spin rounded-full border-2 border-brand-100 border-t-navy motion-reduce:animate-none"
        />
      ) : (
        <CheckBadge />
      )}
      <div aria-live="polite">
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">
          {preparing ? "Preparing your executed copy…" : "Everyone has signed."}
        </h1>
        <p className="mt-1 text-sm font-medium text-ink">{view.title}</p>
        <p className="mt-2 text-sm text-muted">
          {preparing
            ? "Everyone has signed. We're sealing the document now; this usually takes under a minute."
            : "Your executed copy is being prepared; we'll email it."}
        </p>
      </div>
      {view.signedAt ? (
        <p className="mt-1 text-xs text-muted-soft">
          You signed {formatPhoenix(view.signedAt)}
        </p>
      ) : null}
      {!preparing ? (
        <button type="button" onClick={check} disabled={busy} className={`${secondaryBtn} mt-5`}>
          {busy ? "Checking…" : "Check status"}
        </button>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-sm text-muted">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function CompletedCard({
  token,
  view,
  onView,
}: {
  token: string;
  view: Extract<SigningView, { state: "completed" }>;
  onView: (v: SigningView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowClosed, setWindowClosed] = useState(false);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // A fresh 60-second URL per click; it carries a download filename, so the
      // page stays put while the browser saves the file.
      const r = await post({ action: "sealed_url", token });
      if (r.ok) {
        window.location.assign(r.data.url);
        return;
      }
      if (r.error.code === "download_expired") {
        setWindowClosed(true);
      } else if (RECOVER.has(r.error.code)) {
        const g = await post({ action: "get", token });
        if (g.ok && g.data.state !== "completed") {
          onView(g.data);
          return;
        }
      }
      setError(messageFor(r.error));
    } catch {
      setError(GENERIC);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${card} text-center`}>
      <CheckBadge />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">
        Signed and completed.
      </h1>
      <p className="mt-1 text-sm font-medium text-ink">{view.title}</p>
      <p className="mt-2 text-sm text-muted">
        Everyone has signed. The executed copy was emailed to {view.emailMasked}.
      </p>
      <p className="mt-1 text-xs text-muted-soft">
        Completed {formatPhoenix(view.completedAt)}
      </p>
      {view.sealedDownloadAvailable && !windowClosed ? (
        <button
          type="button"
          onClick={download}
          disabled={busy}
          className={`${primaryBtn} mt-6`}
        >
          {busy ? "Preparing…" : "Download signed PDF"}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function OpenFlow({
  token,
  view,
  onView,
  onSubmitted,
  onDeclined,
  onNotice,
}: {
  token: string;
  view: OpenView;
  onView: (v: SigningView) => void;
  onSubmitted: (v: SigningView) => void;
  onDeclined: (v: SigningView) => void;
  onNotice: (text: string) => void;
}) {
  // The document loads only after a click in this page session, even when an
  // earlier visit already recorded "viewed" (no request on page load).
  const [revealed, setRevealed] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const inflight = useRef(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  // Fallback document viewer
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [originalOpened, setOriginalOpened] = useState(false);

  // Identity: the session proves *this browser* entered the code.
  const [sentMask, setSentMask] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(view.otpResendAvailableAt !== null);
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState<string | null>(view.otpResendAvailableAt);
  const [resendDeadline, setResendDeadline] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [otpSession, setOtpSession] = useState<string | null>(null);
  const [otpSessionExpiresAt, setOtpSessionExpiresAt] = useState<string | null>(null);

  // Signature + boxes + consent
  const [adopted, setAdopted] = useState<AdoptedSignature | null>(null);
  const [applied, setApplied] = useState<ReadonlySet<string>>(() => new Set());
  const [adoptOpen, setAdoptOpen] = useState(false);
  const pendingField = useRef<string | null>(null);
  const [consent, setConsent] = useState(false);
  const consentRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  // Decline
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!resendAt) {
      setResendDeadline(null);
      return;
    }
    const remaining = Date.parse(resendAt) - Date.now();
    const wait = Number.isFinite(remaining)
      ? Math.min(RESEND_WAIT_CAP_MS, Math.max(0, remaining))
      : 0;
    setResendDeadline(Date.now() + wait);
  }, [resendAt]);

  useEffect(() => {
    if (resendDeadline === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= resendDeadline) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendDeadline]);

  const resendWait =
    resendDeadline !== null && now !== null
      ? Math.max(0, Math.ceil((resendDeadline - now) / 1000))
      : 0;

  const myFields = useMemo(() => [...view.fields].sort(byPosition), [view.fields]);
  const signatureFields = myFields.filter((f) => f.kind === "signature");
  const requiredSignatures = signatureFields.filter((f) => f.required);
  const appliedIds = signatureFields.filter((f) => applied.has(f.id)).map((f) => f.id);
  const requiredDone = requiredSignatures.filter((f) => applied.has(f.id)).length;
  const nextRequired = requiredSignatures.find((f) => !applied.has(f.id)) ?? null;

  const otpPending = view.requireOtp && otpSession === null;
  const phoneMask = sentMask ?? view.phoneMask;
  const paragraphs = paragraphsOf(view.consentText);
  const canSubmit =
    revealed &&
    consent &&
    adopted !== null &&
    nextRequired === null &&
    appliedIds.length > 0 &&
    !otpPending &&
    busy === null;

  // One request in flight at a time; the ref closes the double-click gap
  // before the disabled state renders.
  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(kind);
    try {
      await fn();
    } catch {
      // The post helpers never throw; this only guards a coding slip.
      setFlash({ area: BUSY_AREA[kind], tone: "error", text: GENERIC });
    } finally {
      inflight.current = false;
      setBusy(null);
    }
  }

  async function fail(area: Area, err: EsignApiError) {
    const text = messageFor(err);
    if (err.code === "otp_required") {
      setOtpSession(null);
      setOtpSessionExpiresAt(null);
      setDeclineOpen(false);
      setFlash({ area: "otp", tone: "error", text });
      return;
    }
    if (err.code === "otp_cooldown" && err.resendAvailableAt) {
      setCodeSent(true);
      setResendAt(err.resendAvailableAt);
    }
    if (err.code === "document_changed") onNotice(text);
    if (RECOVER.has(err.code)) {
      const g = await post({ action: "get", token });
      if (g.ok) {
        onView(g.data);
        if (g.data.state !== "open") return;
      }
    }
    setFlash({ area, tone: "error", text });
  }

  function review() {
    if (view.viewed) {
      // Already recorded on an earlier visit; this click only loads the document.
      setFlash(null);
      setRevealed(true);
      return;
    }
    void run("view", async () => {
      setFlash(null);
      const r = await post({ action: "view", token });
      if (!r.ok) return fail("review", r.error);
      onView(r.data);
      if (r.data.state === "open") setRevealed(true);
    });
  }

  function openSource(newTab: boolean) {
    if (inflight.current) return;
    // Open the tab inside the click so popup blockers (iOS Safari especially)
    // allow it, then point it at the freshly minted 60-second URL.
    const tab = newTab ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    void run("source", async () => {
      setFlash(null);
      const r = await post({ action: "source_url", token });
      if (!r.ok) {
        tab?.close();
        return fail("source", r.error);
      }
      if (!newTab) {
        setSourceUrl(r.data.url);
      } else if (tab) {
        tab.location.replace(r.data.url);
      } else {
        window.open(r.data.url, "_blank", "noopener,noreferrer");
      }
    });
  }

  // The fallback replaces the sandboxed viewer after the Review click, so
  // loading the browser's own PDF viewer right away is still click-driven.
  const fallbackLoaded = useRef(false);
  useEffect(() => {
    if (!fallback || fallbackLoaded.current) return;
    fallbackLoaded.current = true;
    openSource(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallback]);

  function activateField(fieldId: string) {
    if (!signatureFields.some((f) => f.id === fieldId)) return;
    if (adopted === null) {
      pendingField.current = fieldId;
      setAdoptOpen(true);
      return;
    }
    setApplied((prev) => {
      const next = new Set(prev);
      if (next.has(fieldId)) next.delete(fieldId);
      else next.add(fieldId);
      return next;
    });
  }

  function adopt(next: AdoptedSignature) {
    setAdopted(next);
    setAdoptOpen(false);
    const fieldId = pendingField.current;
    pendingField.current = null;
    if (fieldId) {
      setApplied((prev) => {
        if (prev.has(fieldId)) return prev;
        const out = new Set(prev);
        out.add(fieldId);
        return out;
      });
    }
  }

  function closeAdopt() {
    pendingField.current = null;
    setAdoptOpen(false);
  }

  function sendCode() {
    void run("send_otp", async () => {
      setFlash(null);
      const r = await post({ action: "send_otp", token });
      if (!r.ok) return fail("otp", r.error);
      setCodeSent(true);
      setCode("");
      setResendAt(r.data.resendAvailableAt);
      if (r.data.phoneMask) setSentMask(r.data.phoneMask);
      setFlash({
        area: "otp",
        tone: "info",
        text: `Code sent to ${r.data.phoneMask ?? phoneMask ?? "your phone"}.`,
      });
    });
  }

  function verifyCode(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setFlash({ area: "otp", tone: "error", text: "Enter the 6-digit code from the text." });
      return;
    }
    void run("verify", async () => {
      setFlash(null);
      const r = await post({ action: "verify_otp", token, code });
      if (!r.ok) {
        if (r.error.code === "otp_locked" || r.error.code === "otp_code_expired") {
          setCode("");
        }
        return fail("otp", r.error);
      }
      setOtpSession(r.data.otpSession);
      setOtpSessionExpiresAt(r.data.sessionExpiresAt);
      setCode("");
      setFlash({ area: "otp", tone: "info", text: "Phone verified." });
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || adopted === null) return;
    const a = adopted;
    const signature: SubmitSignature =
      a.method === "drawn"
        ? { method: "drawn", png: a.png, inkLength: Math.min(1_000_000, Math.max(0, Math.round(a.inkLength))) }
        : { method: "typed", text: normalizeSignerText(a.text) };
    const ids = [...appliedIds];
    const session = otpSession;
    void run("submit", async () => {
      setFlash(null);
      const r = await post({
        action: "submit",
        token,
        consent: true,
        printedName: normalizeSignerText(a.printedName),
        timeZone: browserTimeZone(),
        signature,
        appliedFieldIds: ids,
        ...(session ? { otpSession: session } : {}),
      });
      if (!r.ok) return fail("sign", r.error);
      onSubmitted(r.data);
    });
  }

  function decline(e: FormEvent) {
    e.preventDefault();
    if (otpPending) return;
    const trimmed = reason.trim().slice(0, 1000);
    const session = otpSession;
    void run("decline", async () => {
      setFlash(null);
      const r = await post({
        action: "decline",
        token,
        ...(trimmed ? { reason: trimmed } : {}),
        ...(session ? { otpSession: session } : {}),
      });
      if (!r.ok) return fail("decline", r.error);
      onDeclined(r.data);
    });
  }

  // "Next" walks the signer to whatever still blocks Submit.
  const next: { label: string; go: () => void } | null = !revealed
    ? null
    : nextRequired
      ? { label: "Next Sign box", go: () => focusById(esignFieldDomId(nextRequired.id)) }
      : otpPending
        ? { label: "Verify phone", go: () => focusById(OTP_SECTION_ID) }
        : !consent
          ? {
              label: "Agree to terms",
              go: () => {
                consentRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                consentRef.current?.focus({ preventScroll: true });
              },
            }
          : null;

  const pageLabel = `${view.pageCount} ${view.pageCount === 1 ? "page" : "pages"}`;
  const fingerprint = view.original?.sha256 ?? view.renderSha256;

  const fallbackSection = (
    <section className={card}>
      <h2 className={eyebrow}>
        {view.mode === "certificate" ? "Signature page" : "Read the document"}
      </h2>
      <p className="mt-2 text-sm text-muted">
        We couldn&apos;t show the page with your signature boxes, so it opens in
        your browser&apos;s viewer instead. Each open fetches a fresh copy through a
        link that expires after a minute. Use the list below to sign your boxes.
      </p>
      {sourceUrl ? (
        <object
          key={sourceUrl}
          data={sourceUrl}
          type="application/pdf"
          aria-label={`${view.title} (PDF)`}
          className="mt-4 h-[70vh] w-full rounded-xl border border-line"
        >
          <p className="p-4 text-sm text-muted">
            Your browser can&apos;t show the PDF here.{" "}
            <button
              type="button"
              onClick={() => openSource(true)}
              className="font-semibold text-brand-700 underline-offset-4 hover:underline"
            >
              Open in a new tab
            </button>
          </p>
        </object>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          type="button"
          onClick={() => openSource(false)}
          disabled={busy !== null}
          className={secondaryBtn}
        >
          {busy === "source"
            ? "Opening…"
            : sourceUrl
              ? "Reload the document"
              : "Open the document"}
        </button>
        <button
          type="button"
          onClick={() => openSource(true)}
          disabled={busy !== null}
          className={quietBtn}
        >
          Open in a new tab
        </button>
      </div>
      <FlashLine flash={flash} area="source" />

      <h3 className="mt-6 text-sm font-semibold text-ink">Your boxes</h3>
      <ul className="mt-2 divide-y divide-line border-y border-line">
        {myFields.map((f) => {
          const where = `page ${f.page + 1}`;
          if (f.kind === "signature") {
            const on = adopted !== null && applied.has(f.id);
            return (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <span className="text-ink">
                  Signature{f.required ? "" : " (optional)"} · {where}
                </span>
                <button
                  id={esignFieldDomId(f.id)}
                  type="button"
                  aria-pressed={on}
                  onClick={() => activateField(f.id)}
                  className={on ? secondaryBtn : `${secondaryBtn} border-navy text-navy`}
                >
                  {on ? "Signed · Remove" : "Sign"}
                </button>
              </li>
            );
          }
          return (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <span className="text-ink">
                {f.kind === "printed_name" ? "Printed name" : "Date signed"} · {where}
              </span>
              <span className="text-muted">
                {f.kind === "printed_name"
                  ? adopted
                    ? normalizeSignerText(adopted.printedName)
                    : "Added from your signature"
                  : "Added when you submit"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* 1. Summary */}
      <section className={card}>
        <p className={eyebrow}>Review &amp; sign</p>
        <p className="mt-2 text-sm text-muted">
          {view.providerName} sent this document to {view.recipientName} to review
          and sign electronically.
        </p>
        {view.position ? (
          <p className="mt-1 text-sm font-medium text-ink">
            You are signer {view.position.order} of {view.position.total}.
          </p>
        ) : view.signerCount > 1 ? (
          <p className="mt-1 text-sm font-medium text-ink">
            {view.signerCount} people are signing this.
          </p>
        ) : null}
        {view.requireStaffSession ? (
          <p className="mt-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-ink">
            You&apos;re signing for {site.name}. Sign in to the GBTN portal as yourself
            in this browser before signing.{" "}
            <a
              href="/team"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-brand-700 underline-offset-4 hover:underline"
            >
              Sign in
            </a>
          </p>
        ) : null}
        <dl className="mt-4 divide-y divide-line border-t border-line text-sm">
          <Row label="Document">{view.title}</Row>
          <Row label="Type">{view.docTypeLabel}</Row>
          <Row label="Version">{view.version}</Row>
          <Row label="From">{view.providerName}</Row>
          <Row label="For">{view.clientName}</Row>
          <Row label="Pages">
            {view.mode === "certificate"
              ? `Signature ${view.pageCount === 1 ? "page" : `pages (${view.pageCount})`} · original attached`
              : pageLabel}
          </Row>
          <Row label="Fingerprint">
            <span title={fingerprint} className="font-mono text-xs">
              SHA-256 {fingerprint.slice(0, 16)}…
            </span>
          </Row>
          <Row label="Link expires">{formatPhoenix(view.expiresAt)}</Row>
        </dl>
        {!revealed ? (
          <div className="mt-5">
            <button
              type="button"
              onClick={review}
              disabled={busy !== null}
              className={`${primaryBtn} w-full sm:w-auto`}
            >
              {busy === "view" ? "Opening…" : "Review the document"}
            </button>
            <FlashLine flash={flash} area="review" />
          </div>
        ) : null}
      </section>

      {revealed ? (
        <>
          <div className="space-y-4 sm:space-y-5">
            {/* 2. Document with this signer's boxes */}
            {view.mode === "certificate" ? (
              fallback ? (
                <>
                  <OriginalFileCard
                    view={view}
                    token={token}
                    onOriginalOpened={() => setOriginalOpened(true)}
                  />
                  {fallbackSection}
                </>
              ) : (
                <CertificateReview
                  view={view}
                  token={token}
                  adopted={adopted}
                  appliedFieldIds={applied}
                  onFieldActivate={activateField}
                  onOriginalOpened={() => setOriginalOpened(true)}
                  onFallback={() => setFallback(true)}
                />
              )
            ) : fallback ? (
              fallbackSection
            ) : (
              <section className={docCard}>
                <h2 className={`${eyebrow} px-2 pt-2 sm:p-0`}>Review and sign</h2>
                <div className="mt-3 px-1 sm:px-0">
                  <DocumentFieldsView
                    view={view}
                    token={token}
                    adopted={adopted}
                    appliedFieldIds={applied}
                    onFieldActivate={activateField}
                    onFallback={() => setFallback(true)}
                  />
                </div>
              </section>
            )}

            {/* 3. Identity */}
            {view.requireOtp ? (
              otpSession !== null ? (
                <section id={OTP_SECTION_ID} tabIndex={-1} className={`${card} focus:outline-none`}>
                  <h2 className={eyebrow}>Verify your phone</h2>
                  <p className="mt-2 text-sm text-ink">
                    Phone verified
                    {otpSessionExpiresAt
                      ? ` until ${formatPhoenixTime(otpSessionExpiresAt)}`
                      : ""}
                    . Reloading this page means verifying again.
                  </p>
                  <FlashLine flash={flash} area="otp" />
                </section>
              ) : (
                <section id={OTP_SECTION_ID} tabIndex={-1} className={`${card} focus:outline-none`}>
                  <h2 className={eyebrow}>Verify your phone</h2>
                  <p className="mt-2 text-sm text-muted">
                    We&apos;ll text a 6-digit code to{" "}
                    {phoneMask ?? "the phone number GBTN has on file"}.
                  </p>
                  {!codeSent ? (
                    <button
                      type="button"
                      onClick={sendCode}
                      disabled={busy !== null}
                      className={`${primaryBtn} mt-4`}
                    >
                      {busy === "send_otp" ? "Sending…" : "Text me a code"}
                    </button>
                  ) : (
                    <form
                      onSubmit={verifyCode}
                      className="mt-4 flex flex-wrap items-end gap-3"
                    >
                      <div>
                        <label htmlFor="esign-otp" className={labelCls}>
                          Code
                        </label>
                        <input
                          id="esign-otp"
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={6}
                          pattern="\d{6}"
                          placeholder="000000"
                          value={code}
                          onChange={(e) =>
                            setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                          }
                          className={codeField}
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={busy !== null || code.length !== 6}
                        className={primaryBtn}
                      >
                        {busy === "verify" ? "Verifying…" : "Verify"}
                      </button>
                      <button
                        type="button"
                        onClick={sendCode}
                        disabled={busy !== null || resendWait > 0}
                        className={`${quietBtn} pb-3`}
                      >
                        {busy === "send_otp"
                          ? "Sending…"
                          : resendWait > 0
                            ? `Resend in ${resendWait}s`
                            : "Resend code"}
                      </button>
                    </form>
                  )}
                  <FlashLine flash={flash} area="otp" />
                </section>
              )
            ) : null}

            {/* 4. Consent + adopted signature */}
            <form id={SIGN_FORM_ID} onSubmit={submit}>
              <section
                aria-disabled={otpPending || undefined}
                className={`${card} ${otpPending ? "opacity-60" : ""}`}
              >
                <h2 className={eyebrow}>Agree and sign</h2>
                {otpPending ? (
                  <p className="mt-2 text-sm text-muted">
                    Verify your phone above to continue.
                  </p>
                ) : null}
                <div
                  role="region"
                  aria-label="Electronic signature terms"
                  tabIndex={0}
                  className="mt-3 max-h-[45vh] space-y-3 overflow-y-auto rounded-xl border border-line bg-paper-soft px-4 py-3.5 text-sm leading-relaxed text-paper-ink focus:outline-none focus:ring-2 focus:ring-brand-100"
                >
                  {paragraphs.map((p, i) => (
                    <p key={i} className="whitespace-pre-line">
                      {p}
                    </p>
                  ))}
                </div>

                <fieldset
                  disabled={otpPending || busy === "submit"}
                  className="mt-5 space-y-5"
                >
                  <div>
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        ref={consentRef}
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                        className="mt-0.5 h-5 w-5 shrink-0 accent-navy"
                      />
                      {/* Exactly the snapshotted, hashed checkbox text. */}
                      <span className="whitespace-pre-line text-sm leading-relaxed text-ink">
                        {view.checkboxText}
                      </span>
                    </label>
                    {view.mode === "certificate" && !originalOpened ? (
                      <p className="mt-1.5 pl-8 text-xs text-muted-soft">
                        You haven&apos;t opened the original yet.
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <p className={labelCls}>Your signature</p>
                    {adopted ? (
                      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-white px-4 py-3">
                        <div className="min-w-0">
                          {adopted.method === "drawn" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={adopted.png}
                              alt="Your drawn signature"
                              className="h-14 w-auto max-w-full object-contain"
                            />
                          ) : (
                            <TypedSignaturePreview
                              text={adopted.text}
                              className="block max-w-full truncate text-4xl leading-tight text-ink"
                            />
                          )}
                          <p className="mt-1 text-xs text-muted">
                            Printed name: {normalizeSignerText(adopted.printedName)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            pendingField.current = null;
                            setAdoptOpen(true);
                          }}
                          className={quietBtn}
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-brand-200 bg-white px-4 py-3">
                        <p className="text-sm text-muted">
                          Tap a Sign box on the document to create your signature.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            pendingField.current = nextRequired?.id ?? null;
                            setAdoptOpen(true);
                          }}
                          className={secondaryBtn}
                        >
                          Create signature
                        </button>
                      </div>
                    )}
                    {view.fields.some((f) => f.kind !== "signature") ? (
                      <p className="mt-1.5 text-xs text-muted-soft">
                        Your printed name and the date are added to their boxes
                        automatically.
                      </p>
                    ) : null}
                  </div>
                </fieldset>
              </section>
            </form>

            {/* 5. Sticky progress + submit */}
            <div className="sticky bottom-0 z-20 -mx-4 border-t border-line bg-paper-soft/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:bg-white/95 sm:shadow-sm">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <p role="status" aria-live="polite" className="min-w-0 flex-1 text-sm text-ink">
                  <span className="font-semibold">
                    {requiredDone} of {requiredSignatures.length}
                  </span>{" "}
                  required {requiredSignatures.length === 1 ? "signature" : "signatures"}
                  {appliedIds.length > requiredDone
                    ? ` · ${appliedIds.length - requiredDone} optional`
                    : ""}
                </p>
                {next ? (
                  <button type="button" onClick={next.go} className={secondaryBtn}>
                    {next.label}
                  </button>
                ) : null}
                <button
                  ref={submitRef}
                  type="submit"
                  form={SIGN_FORM_ID}
                  disabled={!canSubmit}
                  className={`${primaryBtn} w-full sm:w-auto`}
                >
                  {busy === "submit" ? "Signing…" : "Sign and submit"}
                </button>
              </div>
              <FlashLine flash={flash} area="sign" />
              <p className="mt-2 text-center text-xs text-muted sm:text-left">
                Your IP address, browser and the time of each step are recorded
                and sealed into the signed PDF.
              </p>
            </div>
          </div>

          {/* 6. Decline */}
          <section className="px-1 pb-4">
            {otpPending ? (
              <p className="text-xs text-muted">
                To decline, verify your phone first or email{" "}
                <a
                  href={`mailto:${site.founder.email}`}
                  className="font-medium text-brand-700 underline-offset-4 hover:underline"
                >
                  {site.founder.email}
                </a>
                .
              </p>
            ) : !declineOpen ? (
              <button
                type="button"
                onClick={() => {
                  setDeclineOpen(true);
                  setFlash(null);
                }}
                disabled={busy !== null}
                className={quietBtn}
              >
                Decline to sign
              </button>
            ) : (
              <form onSubmit={decline} className={card}>
                <h2 className={eyebrow}>Decline to sign</h2>
                <label htmlFor="esign-decline-reason" className={`${labelCls} mt-3`}>
                  Reason (optional)
                </label>
                <textarea
                  id="esign-decline-reason"
                  rows={3}
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={field}
                />
                <p className="mt-2 text-xs text-muted">
                  This cancels signing for everyone. GBTN will be notified and this
                  link will stop working.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
                  <button type="submit" disabled={busy !== null} className={dangerBtn}>
                    {busy === "decline" ? "Declining…" : "Confirm decline"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeclineOpen(false)}
                    disabled={busy !== null}
                    className={quietBtn}
                  >
                    Cancel
                  </button>
                </div>
                <FlashLine flash={flash} area="decline" />
              </form>
            )}
          </section>

          <AdoptSignatureModal
            open={adoptOpen}
            defaultName={adopted?.printedName ?? view.recipientName}
            allowTyped={view.allowTypedSignature}
            onAdopt={adopt}
            onClose={closeAdopt}
          />
        </>
      ) : null}
    </div>
  );
}
