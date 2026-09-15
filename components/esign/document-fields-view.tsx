"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { AdoptedSignature } from "@/components/esign/adopt-signature-modal";
import { FieldOutline } from "@/components/esign/field-overlay";
import { PdfPages, type PageSize } from "@/components/esign/pdf-pages";
import { PdfSandbox, fetchVerified } from "@/components/esign/pdf-sandbox";
import { TypedSignaturePreview } from "@/components/esign/typed-signature-preview";
import { displayDims, pageBox, pageFromPdfjs, pagesAgree } from "@/lib/esign/geometry";
import {
  normalizeSignerText,
  signedDateText,
  type EsignAction,
  type EsignApiResult,
  type EsignRequestBody,
  type EsignResponseData,
  type EsignSealBody,
  type EsignSealResponse,
  type OtherField,
  type SigningView,
  type SnapshotPage,
  type ViewField,
} from "@/lib/esign/types";

// The frozen render with this signer's boxes on top. Only runs after the
// signer clicked Review (the parent mounts it then), so nothing is posted on
// page load. Bytes come from a 60-second URL, must hash to the snapshotted
// render SHA-256, and must parse to exactly the snapshotted page boxes before a
// single box is shown; any failure hands over to the parent's <object>
// fallback, so signing never depends on pdf.js.

type OpenView = Extract<SigningView, { state: "open" }>;
type Body<A extends EsignAction> = Extract<EsignRequestBody, { action: A }>;

// ── signer API (shared by the signing UI; every call is caught, never throws) ──

const OFFLINE = "We couldn't reach GBTN. Check your connection and try again.";
const GENERIC = "Something went wrong. Please try again.";

async function postJson<T>(url: string, body: unknown): Promise<EsignApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
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
    if (shaped.ok === true) return json as unknown as EsignApiResult<T>;
    if (shaped.ok === false && typeof shaped.error?.code === "string") {
      return json as unknown as EsignApiResult<T>;
    }
  }
  return {
    ok: false,
    error: { code: res.status === 413 ? "payload_too_large" : "server_error", message: GENERIC },
  };
}

export function postEsign<A extends EsignAction>(
  body: Body<A> & { action: A }
): Promise<EsignApiResult<EsignResponseData[A]>> {
  return postJson<EsignResponseData[A]>("/api/esign", body);
}

export function postSeal(token: string): Promise<EsignSealResponse> {
  const body: EsignSealBody = { action: "seal", token };
  return postJson<SigningView>("/api/esign/seal", body);
}

// ── shared look ──

export const ESIGN_CARD = "rounded-2xl border border-line bg-white p-5 sm:p-6";
export const ESIGN_EYEBROW =
  "font-label text-[11px] font-semibold uppercase tracking-[0.16em] text-muted";
export const ESIGN_PRIMARY_BTN =
  "font-label inline-flex items-center justify-center rounded-md bg-gradient-brand px-6 py-3.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100";
export const ESIGN_SECONDARY_BTN =
  "inline-flex items-center justify-center rounded-md border border-line bg-white px-4 py-2.5 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50";
export const ESIGN_QUIET_BTN =
  "text-sm font-medium text-muted underline-offset-4 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50";

export function esignFieldDomId(fieldId: string): string {
  return `esign-field-${fieldId}`;
}

// ── view ──

const SIGNER_MAX_BYTES = 16_000_000;
const MAX_LIVE_CANVASES = 5;
const ZOOMS = [1, 1.5, 2] as const;
const HELVETICA = "Helvetica, Arial, sans-serif"; // what the seal stamps name/date in

function FitText({ text }: { text: string }) {
  const n = Math.max(4, text.length);
  return (
    <span
      className="whitespace-nowrap leading-none text-ink"
      style={{ fontFamily: HELVETICA, fontSize: `min(70cqh, ${(180 / n).toFixed(2)}cqw)` }}
    >
      {text}
    </span>
  );
}

function AppliedSignature({ adopted }: { adopted: AdoptedSignature }) {
  if (adopted.method === "drawn") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={adopted.png} alt="" draggable={false} className="h-full w-full object-contain p-[3%]" />
    );
  }
  const n = Math.max(4, normalizeSignerText(adopted.text).length);
  return (
    <span className="leading-none" style={{ fontSize: `min(62cqh, ${(230 / n).toFixed(2)}cqw)` }}>
      <TypedSignaturePreview text={adopted.text} className="whitespace-nowrap text-ink" />
    </span>
  );
}

export function DocumentFieldsView({
  view,
  token,
  adopted,
  appliedFieldIds,
  onFieldActivate,
  onFallback,
}: {
  view: OpenView;
  token: string;
  adopted: AdoptedSignature | null;
  appliedFieldIds: ReadonlySet<string>;
  onFieldActivate: (fieldId: string) => void;
  onFallback: () => void;
}): React.JSX.Element {
  const [sandbox, setSandbox] = useState<PdfSandbox | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const failed = useRef(false);
  const onFallbackRef = useRef(onFallback);
  const expectedPages = useRef<SnapshotPage[]>(view.pages);

  useEffect(() => {
    onFallbackRef.current = onFallback;
    expectedPages.current = view.pages;
  });

  const fallbackOnce = useCallback(() => {
    if (failed.current) return;
    failed.current = true;
    onFallbackRef.current();
  }, []);

  const renderSha256 = view.renderSha256;
  const pageCount = view.pageCount;

  useEffect(() => {
    let alive = true;
    let created: PdfSandbox | null = null;
    let offCrash: () => void = () => undefined;
    const fail = () => {
      if (alive) fallbackOnce();
    };
    void (async () => {
      try {
        const r = await postEsign({ action: "source_url", token });
        if (!alive) return;
        if (!r.ok || typeof r.data.sha256 !== "string" || r.data.sha256.toLowerCase() !== renderSha256.toLowerCase()) {
          return fail();
        }
        const fetched = await fetchVerified(r.data.url, renderSha256, { maxBytes: SIGNER_MAX_BYTES });
        if (!alive) return;
        if (!fetched.ok) return fail();
        const sb = await PdfSandbox.create();
        if (!alive) {
          sb.destroy();
          return;
        }
        created = sb;
        offCrash = sb.onCrash(fail);
        const opened = await sb.open(fetched.bytes);
        if (!alive) return;
        if (!opened.ok || opened.numPages !== pageCount) return fail();
        const mapped: SnapshotPage[] = [];
        for (const p of opened.pages) {
          const page = pageFromPdfjs(p.index, p.view, p.rotate);
          if (!page) return fail();
          mapped.push(page);
        }
        // What pdf.js sees must be what the server snapshotted and will stamp.
        if (!pagesAgree(mapped, expectedPages.current)) return fail();
        setSandbox(sb);
      } catch {
        fail();
      }
    })();
    return () => {
      alive = false;
      offCrash();
      created?.destroy();
      setSandbox(null);
    };
  }, [token, renderSha256, pageCount, fallbackOnce]);

  const sizes = useMemo<PageSize[]>(
    () =>
      view.pages.map((p) => {
        const { box, r } = pageBox(p);
        const d = displayDims(box, r);
        return { index: p.index, vw: d.vw, vh: d.vh };
      }),
    [view.pages]
  );

  const mineByPage = useMemo(() => groupByPage(view.fields), [view.fields]);
  const othersByPage = useMemo(() => groupByPage(view.otherFields), [view.otherFields]);
  // Same zone signing-flow submits (browserTimeZone) and the same en-US format
  // the engine stores and the seal stamps, so the preview matches the PDF.
  const dateText = useMemo(() => {
    let tz = "UTC";
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (typeof resolved === "string" && resolved.length > 0 && resolved.length <= 64) tz = resolved;
    } catch {
      tz = "UTC";
    }
    try {
      return signedDateText(tz, new Date());
    } catch {
      return "";
    }
  }, []);
  const printedName = adopted ? normalizeSignerText(adopted.printedName) : "";

  function renderOverlay(pageIndex: number): React.ReactNode {
    const others = othersByPage.get(pageIndex) ?? [];
    const mine = mineByPage.get(pageIndex) ?? [];
    return (
      <>
        {others.map((f, i) => (
          <FieldOutline
            key={`other-${i}`}
            rect={f}
            tone={f.signed ? "done" : "other"}
            label={f.signed ? "Signed" : "Another signer"}
            focusable={false}
          />
        ))}
        {mine.map((f) => {
          if (f.kind === "signature") {
            const on = adopted !== null && appliedFieldIds.has(f.id);
            return (
              <FieldOutline
                key={f.id}
                id={esignFieldDomId(f.id)}
                rect={f}
                tone="mine"
                pressed={on}
                label={on ? "Signed" : f.required ? "Sign" : "Sign (optional)"}
                onActivate={() => onFieldActivate(f.id)}
              >
                {on && adopted ? (
                  <AppliedSignature adopted={adopted} />
                ) : (
                  <span
                    className="font-label font-semibold uppercase tracking-[0.12em] text-navy/70"
                    style={{ fontSize: "min(34cqh, 13px)" }}
                  >
                    Tap to sign
                  </span>
                )}
              </FieldOutline>
            );
          }
          const text = f.kind === "printed_name" ? printedName : dateText;
          return (
            <FieldOutline
              key={f.id}
              rect={f}
              tone="mine"
              label={f.kind === "printed_name" ? "Your name" : "Date"}
              focusable={false}
            >
              {text ? <FitText text={text} /> : null}
            </FieldOutline>
          );
        })}
      </>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">
          Your boxes are outlined in navy. Tap each <span className="font-semibold text-ink">Sign</span>{" "}
          box to sign it; your name and the date fill in on their own.
          {view.otherFields.length > 0 ? " Dashed boxes belong to other signers." : ""}
        </p>
        {sandbox ? (
          <div role="group" aria-label="Zoom" className="flex shrink-0 gap-1 rounded-lg bg-paper-soft p-1">
            {ZOOMS.map((z) => (
              <button
                key={z}
                type="button"
                aria-pressed={zoom === z}
                onClick={() => setZoom(z)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  zoom === z ? "bg-white text-navy shadow-sm ring-1 ring-line" : "text-muted hover:text-ink"
                }`}
              >
                {z === 1 ? "Fit" : `${z * 100}%`}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="mt-4">
        {sandbox ? (
          <PdfPages
            sandbox={sandbox}
            pages={sizes}
            maxLiveCanvases={MAX_LIVE_CANVASES}
            zoom={zoom}
            onError={fallbackOnce}
            renderOverlay={renderOverlay}
          />
        ) : (
          <div
            role="status"
            className="grid min-h-48 place-items-center rounded-xl border border-line bg-paper-soft px-4 py-10 text-center text-sm text-muted"
          >
            Loading the document securely…
          </div>
        )}
      </div>
    </div>
  );
}

function groupByPage<T extends ViewField | OtherField>(fields: readonly T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const f of fields) {
    const list = map.get(f.page);
    if (list) list.push(f);
    else map.set(f.page, [f]);
  }
  return map;
}
