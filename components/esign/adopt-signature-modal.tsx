"use client";

import { useEffect, useId, useRef, useState } from "react";
import type React from "react";
import { SIGNATURE_MIN_BYTES, SignaturePad, signaturePngBytes } from "@/components/esign/signature-pad";
import { TypedSignaturePreview } from "@/components/esign/typed-signature-preview";
import { normalizeSignerText, typedCharsetOk } from "@/lib/esign/types";

// Adopt a signature once (Draw or Type), then apply it box by box. The printed
// name is normalized exactly as the server normalizes it (addendum C22), and the
// Type tab uses the server's own charset gate (C23), so Adopt is disabled for
// text the seal couldn't draw. Full-screen under 640 px.

export type AdoptedSignature =
  | { method: "drawn"; png: string; inkLength: number; printedName: string }
  | { method: "typed"; text: string; printedName: string };

const MIN_INK = 40;
const TEXT_MIN = 2;
const TEXT_MAX = 120;

const labelCls = "mb-1.5 block text-sm font-medium text-ink";
const inputCls =
  "w-full rounded-md border border-line bg-white px-4 py-3 text-sm text-ink placeholder:text-muted-soft focus:border-navy-2 focus:outline-none focus:ring-2 focus:ring-brand-100";
const primaryBtn =
  "font-label inline-flex items-center justify-center rounded-md bg-gradient-brand px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100";
const quietBtn =
  "text-sm font-medium text-muted underline-offset-4 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50";

export function AdoptSignatureModal(props: {
  open: boolean;
  defaultName: string;
  allowTyped: boolean;
  onAdopt: (a: AdoptedSignature) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  if (!props.open) return null;
  return <AdoptDialog {...props} />;
}

function AdoptDialog({
  defaultName,
  allowTyped,
  onAdopt,
  onClose,
}: {
  defaultName: string;
  allowTyped: boolean;
  onAdopt: (a: AdoptedSignature) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const typedId = useId();
  const [tab, setTab] = useState<"draw" | "type">("draw");
  const [name, setName] = useState(defaultName);
  const [typed, setTyped] = useState(defaultName);
  const [typedEdited, setTypedEdited] = useState(false);
  const [png, setPng] = useState<string | null>(null);
  const [ink, setInk] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus in, Escape closes, Tab stays inside, the page behind doesn't scroll,
  // and focus returns to the box that opened the dialog.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((n) => n.getClientRects().length > 0);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  const normName = normalizeSignerText(name);
  const nameOk = normName.length >= TEXT_MIN && normName.length <= TEXT_MAX;
  const typedText = normalizeSignerText(typedEdited ? typed : name);
  const typedLengthOk = typedText.length >= TEXT_MIN && typedText.length <= TEXT_MAX;
  const typedCharsOk = typedText.length === 0 || typedCharsetOk(typedText);
  // The server refuses a drawn PNG under SIGNATURE_MIN_BYTES (signature-image.ts)
  // or with inkLength under 40 (engine.ts), so both block Adopt here first.
  const drawTooSmall = png !== null && (ink < MIN_INK || signaturePngBytes(png) < SIGNATURE_MIN_BYTES);
  const drawOk = png !== null && !drawTooSmall;
  const activeTab = allowTyped ? tab : "draw";
  const canAdopt =
    nameOk && (activeTab === "draw" ? drawOk : typedLengthOk && typedCharsOk);

  function adopt() {
    if (!canAdopt) return;
    if (activeTab === "type") {
      onAdopt({ method: "typed", text: typedText, printedName: normName });
    } else if (png !== null) {
      onAdopt({
        method: "drawn",
        png,
        inkLength: Math.min(1_000_000, Math.max(0, Math.round(ink))),
        printedName: normName,
      });
    }
  }

  const tabBtn = (active: boolean) =>
    `flex-1 rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
      active ? "bg-white text-navy shadow-sm ring-1 ring-line" : "text-muted hover:text-ink"
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-navy/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full flex-col overflow-y-auto bg-white p-5 sm:h-auto sm:max-h-[92vh] sm:max-w-lg sm:rounded-2xl sm:border sm:border-line sm:p-6 sm:shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-bold tracking-tight text-ink">
            Adopt your signature
          </h2>
          <button type="button" onClick={onClose} className={quietBtn}>
            Close
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">
          You&apos;ll tap each Sign box to place it, and confirm the agreement before
          submitting.
        </p>

        <div className="mt-5">
          <label htmlFor={nameId} className={labelCls}>
            Your full legal name
          </label>
          <input
            ref={nameRef}
            id={nameId}
            type="text"
            autoComplete="name"
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
          <p className="mt-1.5 text-xs text-muted-soft">
            Printed on the document and the signing certificate.
          </p>
          {name.length > 0 && !nameOk ? (
            <p className="mt-1 text-xs text-crimson">
              Enter your name ({TEXT_MIN}–{TEXT_MAX} characters).
            </p>
          ) : null}
        </div>

        {allowTyped ? (
          <div role="tablist" aria-label="Signature style" className="mt-5 flex gap-1 rounded-lg bg-paper-soft p-1">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "draw"}
              onClick={() => setTab("draw")}
              className={tabBtn(activeTab === "draw")}
            >
              Draw
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "type"}
              onClick={() => setTab("type")}
              className={tabBtn(activeTab === "type")}
            >
              Type
            </button>
          </div>
        ) : null}

        {/* Both panels stay mounted so switching tabs keeps a drawn signature. */}
        <div role={allowTyped ? "tabpanel" : undefined} hidden={activeTab !== "draw"} className="mt-4">
          <p className={labelCls}>Draw your signature</p>
          <SignaturePad
            label="Signature drawing area"
            onChange={(nextPng, nextInk) => {
              setPng(nextPng);
              setInk(nextInk);
            }}
          />
          {/* Always mounted so screen readers announce the text when it appears. */}
          <p aria-live="polite" className="text-xs text-crimson">
            {drawTooSmall ? (
              <span className="mt-1.5 block">
                That signature is too small to use. Keep drawing, or clear it and draw a fuller signature.
              </span>
            ) : null}
          </p>
        </div>

        {allowTyped ? (
          <div role="tabpanel" hidden={activeTab !== "type"} className="mt-4">
            <label htmlFor={typedId} className={labelCls}>
              Type your signature
            </label>
            <input
              id={typedId}
              type="text"
              autoComplete="off"
              maxLength={160}
              value={typedEdited ? typed : name}
              onChange={(e) => {
                setTypedEdited(true);
                setTyped(e.target.value);
              }}
              className={inputCls}
            />
            <div className="mt-3 grid min-h-28 place-items-center overflow-hidden rounded-xl border-2 border-dashed border-brand-200 bg-white px-4 py-3">
              {typedCharsOk && typedText.length > 0 ? (
                <TypedSignaturePreview
                  text={typedText}
                  className="max-w-full truncate text-5xl leading-tight text-ink"
                />
              ) : (
                <span className="text-xs text-muted-soft">Your signature appears here.</span>
              )}
            </div>
            {!typedCharsOk ? (
              <p role="alert" className="mt-2 text-sm text-crimson">
                Your name has characters the typed style can&apos;t show. Draw your
                signature instead.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-x-5 gap-y-3 sm:mt-7">
          <button type="button" onClick={onClose} className={quietBtn}>
            Cancel
          </button>
          <button type="button" onClick={adopt} disabled={!canAdopt} className={`${primaryBtn} w-full sm:w-auto`}>
            Adopt and sign
          </button>
        </div>
      </div>
    </div>
  );
}
