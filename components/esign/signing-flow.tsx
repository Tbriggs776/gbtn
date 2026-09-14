"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { SignaturePad } from "@/components/esign/signature-pad";
import { formatBytes } from "@/lib/format";
import { site } from "@/lib/site";
import type {
  EsignAction,
  EsignApiError,
  EsignApiResult,
  EsignErrorCode,
  EsignRequestBody,
  EsignResponseData,
  SignedView,
  SigningView,
} from "@/lib/esign/types";

// Public signing flow. The token is the only credential: every call is a POST to
// /api/esign carrying it, and nothing is sent on mount — "viewed" is recorded
// only when the signer clicks "Review the document" (so mail scanners that fetch
// the page leave no evidence). A verified-phone otpSession lives in React state
// only, never storage; a reload means verifying again. Every value from the
// snapshot renders as React text — no dangerouslySetInnerHTML anywhere.

type OpenView = Extract<SigningView, { state: "open" }>;
type ClosedView = Exclude<SigningView, { state: "open" | "signed" }>;
type Body<A extends EsignAction> = Extract<EsignRequestBody, { action: A }>;
type Result<A extends EsignAction> = EsignApiResult<EsignResponseData[A]>;

const GENERIC = "Something went wrong. Please try again.";
const OFFLINE = "We couldn't reach GBTN. Check your connection and try again.";
const MIN_INK = 40;
// The server's OTP cooldown is 60 s. Never make the signer wait longer than
// that on the strength of a client clock that may be skewed; the server still
// answers otp_cooldown if they are early.
const RESEND_WAIT_CAP_MS = 60_000;

const MESSAGES: Partial<Record<EsignErrorCode, string>> = {
  bad_request:
    "Something in the form isn't right. Check your name and signature, then try again.",
  unsupported_media_type: "Something went wrong. Refresh the page and try again.",
  forbidden_origin: "Something went wrong. Refresh the page and try again.",
  payload_too_large: "Your signature image is too large. Clear it and sign again.",
  not_found: "This signing link isn't valid.",
  expired: "This signing link has expired.",
  closed: "This signing request is no longer open.",
  already_signed: "This document has already been signed.",
  document_changed:
    "This document changed after it was sent. GBTN has been notified and will send a new link.",
  signature_invalid: "We couldn't read your signature. Clear it and sign again.",
  otp_required: "Your verification expired. Request a new code.",
  otp_not_required: "This document doesn't need a text code.",
  otp_incorrect: "That code isn't right.",
  otp_code_expired: "That code has expired. Request a new one.",
  otp_locked: "Too many attempts. Request a new code.",
  otp_cooldown: "A code was just sent. You can request another shortly.",
  otp_limit: "Too many codes sent. Contact GBTN.",
  sms_failed: "We couldn't text your phone. Contact GBTN.",
  download_expired: "The download window has closed. Ask GBTN for a copy.",
};

// Codes that mean our picture of the request is stale: re-read it with `get`
// and render whatever the server now says.
const RECOVER = new Set<EsignErrorCode>([
  "already_signed",
  "closed",
  "server_error",
  "expired",
  "not_found",
  "document_changed",
  "otp_not_required",
]);

function messageFor(err: EsignApiError): string {
  return MESSAGES[err.code] ?? (err.message || GENERIC);
}

async function post<A extends EsignAction>(
  body: Body<A> & { action: A }
): Promise<Result<A>> {
  let res: Response;
  try {
    res = await fetch("/api/esign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return { ok: false, error: { code: "server_error", message: OFFLINE } };
  }
  const json: unknown = await res.json().catch(() => null);
  if (typeof json === "object" && json !== null) {
    const shaped = json as { ok?: unknown; error?: { code?: unknown } };
    if (shaped.ok === true) return json as unknown as Result<A>;
    if (shaped.ok === false && typeof shaped.error?.code === "string") {
      return json as unknown as Result<A>;
    }
  }
  return {
    ok: false,
    error: {
      code: res.status === 413 ? "payload_too_large" : "server_error",
      message: GENERIC,
    },
  };
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

const card = "rounded-2xl border border-line bg-white p-5 sm:p-6";
const eyebrow =
  "font-label text-[11px] font-semibold uppercase tracking-[0.16em] text-muted";
const labelCls = "mb-1.5 block text-sm font-medium text-ink";
const field =
  "w-full rounded-md border border-line bg-white px-4 py-3 text-sm text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-paper-soft";
const codeField =
  "w-40 rounded-md border border-line bg-white px-3 py-2.5 text-center text-lg tracking-[0.3em] text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100";
const primaryBtn =
  "font-label inline-flex items-center justify-center rounded-md bg-gradient-brand px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100";
const secondaryBtn =
  "inline-flex items-center justify-center rounded-md border border-line bg-white px-4 py-2.5 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50";
const quietBtn =
  "text-sm font-medium text-muted underline-offset-4 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50";
const dangerBtn =
  "inline-flex items-center justify-center rounded-md border border-crimson/40 bg-white px-4 py-2.5 text-sm font-semibold text-crimson transition-colors hover:bg-crimson/5 disabled:cursor-not-allowed disabled:opacity-50";

type Area = "review" | "source" | "otp" | "sign" | "decline";
type Flash = { area: Area; tone: "error" | "info"; text: string };

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

export function SigningFlow({
  token,
  initial,
}: {
  token: string;
  initial: SigningView;
}) {
  const [view, setView] = useState<SigningView>(initial);
  const [notice, setNotice] = useState<string | null>(null);

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
          onView={setView}
          onNotice={setNotice}
        />
      ) : view.state === "signed" ? (
        <SignedCard token={token} view={view} onView={setView} />
      ) : (
        <ClosedCard view={view} />
      )}
    </div>
  );
}

function ClosedCard({ view }: { view: ClosedView }) {
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
      heading = `You declined to sign ${view.title}.`;
      body = "GBTN has been notified.";
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

function SignedCard({
  token,
  view,
  onView,
}: {
  token: string;
  view: SignedView;
  onView: (v: SigningView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowClosed, setWindowClosed] = useState(false);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    // A fresh 60-second URL per click; it carries a download filename, so the
    // page stays put while the browser saves the file.
    const r = await post({ action: "sealed_url", token });
    if (r.ok) {
      window.location.assign(r.data.url);
      setBusy(false);
      return;
    }
    if (r.error.code === "download_expired") {
      setWindowClosed(true);
    } else if (RECOVER.has(r.error.code)) {
      const g = await post({ action: "get", token });
      if (g.ok && g.data.state !== "signed") {
        onView(g.data);
        return;
      }
    }
    setError(messageFor(r.error));
    setBusy(false);
  }

  return (
    <section className={`${card} text-center`}>
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
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">
        Signed. Thank you.
      </h1>
      <p className="mt-1 text-sm font-medium text-ink">{view.title}</p>
      <p className="mt-2 text-sm text-muted">
        A signed copy was emailed to {view.signerEmailMasked}.
      </p>
      <p className="mt-1 text-xs text-muted-soft">
        Signed {formatPhoenix(view.signedAt)}
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

type Busy = null | "view" | "source" | "send_otp" | "verify" | "submit" | "decline";

function OpenFlow({
  token,
  view,
  onView,
  onNotice,
}: {
  token: string;
  view: OpenView;
  onView: (v: SigningView) => void;
  onNotice: (text: string) => void;
}) {
  // Already viewed (e.g. a reload): skip the Review gate without re-posting.
  const [revealed, setRevealed] = useState(view.viewed);
  const [busy, setBusy] = useState<Busy>(null);
  const inflight = useRef(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  // Document preview
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceOpened, setSourceOpened] = useState(false);

  // Identity (S2): the session proves *this browser* entered the code.
  const [sentMask, setSentMask] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(view.otpResendAvailableAt !== null);
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState<string | null>(view.otpResendAvailableAt);
  const [resendDeadline, setResendDeadline] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [otpSession, setOtpSession] = useState<string | null>(null);
  const [otpSessionExpiresAt, setOtpSessionExpiresAt] = useState<string | null>(null);

  // Consent + signature
  const [consent, setConsent] = useState(false);
  const [printedName, setPrintedName] = useState("");
  const [png, setPng] = useState<string | null>(null);
  const [inkLength, setInkLength] = useState(0);

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

  const otpPending = view.requireOtp && otpSession === null;
  const phoneMask = sentMask ?? view.phoneMask;
  const paragraphs = paragraphsOf(view.consentText);
  const canSubmit =
    consent &&
    printedName.trim().length >= 2 &&
    png !== null &&
    inkLength >= MIN_INK &&
    (!view.requireOtp || otpSession !== null) &&
    busy === null;

  // One request in flight at a time; the ref closes the double-click gap
  // before the disabled state renders.
  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(kind);
    try {
      await fn();
    } finally {
      inflight.current = false;
      setBusy(null);
    }
  }

  function applyView(next: SigningView) {
    onView(next);
    if (next.state === "open" && next.viewed) setRevealed(true);
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
        applyView(g.data);
        if (g.data.state !== "open") return;
      }
    }
    setFlash({ area, tone: "error", text });
  }

  function review() {
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
      setSourceOpened(true);
      if (!newTab) {
        setSourceUrl(r.data.url);
      } else if (tab) {
        tab.location.replace(r.data.url);
      } else {
        window.open(r.data.url, "_blank", "noopener,noreferrer");
      }
    });
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
    if (!canSubmit || png === null) return;
    const signaturePng = png;
    void run("submit", async () => {
      setFlash(null);
      const r = await post({
        action: "submit",
        token,
        consent: true,
        printedName: printedName.trim(),
        signaturePng,
        inkLength: Math.min(1_000_000, Math.round(inkLength)),
        ...(otpSession ? { otpSession } : {}),
      });
      if (!r.ok) return fail("sign", r.error);
      onView(r.data);
    });
  }

  function decline(e: FormEvent) {
    e.preventDefault();
    if (view.requireOtp && otpSession === null) return;
    const trimmed = reason.trim().slice(0, 1000);
    void run("decline", async () => {
      setFlash(null);
      const r = await post({
        action: "decline",
        token,
        ...(trimmed ? { reason: trimmed } : {}),
        ...(otpSession ? { otpSession } : {}),
      });
      if (!r.ok) return fail("decline", r.error);
      onView(r.data);
    });
  }

  const pages = `${view.pageCount} ${view.pageCount === 1 ? "page" : "pages"}`;

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* 1. Summary */}
      <section className={card}>
        <p className={eyebrow}>Review &amp; sign</p>
        <p className="mt-2 text-sm text-muted">
          {view.providerName} sent this document to {view.signerName} to review
          and sign electronically.
        </p>
        <dl className="mt-4 divide-y divide-line border-t border-line text-sm">
          <Row label="Document">{view.title}</Row>
          <Row label="Type">{view.docTypeLabel}</Row>
          <Row label="Version">{view.version}</Row>
          <Row label="From">{view.providerName}</Row>
          <Row label="For">{view.clientName}</Row>
          <Row label="File">
            <span className="break-all">{view.fileName}</span> · {pages} ·{" "}
            {formatBytes(view.byteSize)}
          </Row>
          <Row label="Fingerprint">
            <span title={view.sourceSha256} className="font-mono text-xs">
              SHA-256 {view.sourceSha256.slice(0, 16)}…
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
          {/* 2. Document */}
          <section className={card}>
            <h2 className={eyebrow}>Read the document</h2>
            <p className="mt-2 text-sm text-muted">
              Read the full document before you sign. Each open fetches a fresh
              copy through a link that expires after a minute.
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
          </section>

          {/* 3. Identity */}
          {view.requireOtp ? (
            otpSession !== null ? (
              <section className={card}>
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
              <section className={card}>
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

          {/* 4. Consent + signature, 5. Submit */}
          <form onSubmit={submit} className="space-y-4 sm:space-y-5">
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
                  {!sourceOpened ? (
                    <p className="mt-1.5 pl-8 text-xs text-muted-soft">
                      You haven&apos;t opened the document yet.
                    </p>
                  ) : null}
                </div>

                <div>
                  <label htmlFor="esign-name" className={labelCls}>
                    Type your full legal name
                  </label>
                  <input
                    id="esign-name"
                    type="text"
                    autoComplete="name"
                    maxLength={120}
                    value={printedName}
                    onChange={(e) => setPrintedName(e.target.value)}
                    className={field}
                  />
                  <p className="mt-1.5 text-xs text-muted-soft">
                    Sent to {view.signerName}
                  </p>
                </div>

                <div>
                  <p className={labelCls}>Draw your signature</p>
                  <SignaturePad
                    label="Signature drawing area"
                    disabled={otpPending || busy === "submit"}
                    onChange={(nextPng, nextInk) => {
                      setPng(nextPng);
                      setInkLength(nextInk);
                    }}
                  />
                  {png !== null && inkLength < MIN_INK ? (
                    <p className="mt-1.5 text-xs text-crimson">
                      That signature is very short. Clear it and draw your full
                      signature.
                    </p>
                  ) : null}
                </div>
              </fieldset>
            </section>

            <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-paper-soft/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
              <button
                type="submit"
                disabled={!canSubmit}
                className={`${primaryBtn} w-full`}
              >
                {busy === "submit" ? "Signing…" : "Sign and submit"}
              </button>
              <FlashLine flash={flash} area="sign" />
              <p className="mt-2 text-center text-xs text-muted">
                Your IP address, browser and the time of each step are recorded
                and sealed into the signed PDF.
              </p>
            </div>
          </form>

          {/* 6. Decline */}
          <section className="px-1 pb-4">
            {view.requireOtp && otpSession === null ? (
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
                  GBTN will be notified and this link will stop working.
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
        </>
      ) : null}
    </div>
  );
}
