"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Result = { ok?: boolean; error?: string; message?: string; warnings?: string[] };

/** Vercel drops request bodies over ~4.5 MB at the edge; stay clear of it. */
const MAX_BODY = 4_000_000;

/**
 * Gzip in the browser so the export fits under the platform's body limit.
 * The real RFMS export is 11.5 MB of CSV, which compresses ~6x. Returns the
 * original bytes if the browser has no CompressionStream, or if compressing
 * didn't help (xlsx is already a zip).
 */
async function pack(file: File): Promise<{ body: BodyInit; gzipped: boolean; size: number }> {
  const raw = await file.arrayBuffer();
  if (typeof CompressionStream === "undefined") {
    return { body: raw, gzipped: false, size: raw.byteLength };
  }
  try {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
    const gz = await new Response(stream).blob();
    return gz.size < raw.byteLength
      ? { body: gz, gzipped: true, size: gz.size }
      : { body: raw, gzipped: false, size: raw.byteLength };
  } catch {
    return { body: raw, gzipped: false, size: raw.byteLength };
  }
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

export function OrdersUploader({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"idle" | "packing" | "sending" | "importing">("idle");
  const [result, setResult] = useState<Result>({});
  const formRef = useRef<HTMLFormElement>(null);

  const busy = stage !== "idle";

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = new FormData(e.currentTarget).get("file");
    if (!(file instanceof File) || file.size === 0) {
      setResult({ error: "Choose an RFMS Orders export to upload." });
      return;
    }

    setResult({});
    setStage("packing");
    try {
      const { body, gzipped, size } = await pack(file);
      if (size > MAX_BODY) {
        setResult({
          error: `That export is ${mb(file.size)} (${mb(size)} compressed) — too large to upload in one piece. Filter the RFMS export to a narrower date range and try again.`,
        });
        setStage("idle");
        return;
      }

      setStage("sending");
      const res = await fetch(`/api/ops/import?client=${encodeURIComponent(clientId)}`, {
        method: "POST",
        headers: gzipped
          ? { "content-type": "application/octet-stream", "x-gbtn-encoding": "gzip" }
          : { "content-type": "application/octet-stream" },
        body,
      });
      setStage("importing");

      // A failed upload must render as an error, never throw — an exception here
      // is what blanked the page when the 11 MB body came back as a plain-text
      // 413 instead of JSON.
      const data: Result = await res.json().catch(() => ({
        error:
          res.status === 413
            ? "The server rejected the upload as too large."
            : `The import failed (${res.status}).`,
      }));

      if (res.ok && data.ok) {
        setResult(data);
        formRef.current?.reset();
        router.refresh();
      } else {
        setResult({ error: data.error ?? `The import failed (${res.status}).` });
      }
    } catch {
      setResult({ error: "The upload didn't reach the server. Check your connection and retry." });
    } finally {
      setStage("idle");
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="font-label inline-flex items-center gap-2 rounded-md bg-gradient-brand px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
          <path d="M12 16V4m0 0L8 8m4-4l4 4M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Import orders
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-line bg-white p-6 ring-card sm:w-[34rem]">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-bold text-ink">Import RFMS orders</h3>
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          className="text-sm text-muted hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>

      <p className="mt-2 text-sm text-muted">
        Upload the <span className="font-medium text-ink">Orders</span> export from RFMS (CSV or
        XLSX). It&apos;s a full snapshot, so importing <span className="font-medium text-ink">replaces</span>{" "}
        every order line for this client — lines deleted in RFMS disappear here too.
      </p>

      <form ref={formRef} onSubmit={submit} className="mt-4 space-y-4">
        <input
          type="file"
          name="file"
          accept=".csv,.xlsx,.xls"
          required
          disabled={busy}
          className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border-0 file:bg-ink file:px-4 file:py-2 file:text-sm file:font-semibold file:text-cream hover:file:bg-ink-soft disabled:opacity-60"
        />

        {result.error ? <p className="text-sm text-red-600">{result.error}</p> : null}
        {result.ok && result.message ? (
          <p className="text-sm text-brand-700">{result.message}</p>
        ) : null}
        {result.warnings?.length ? (
          <ul className="space-y-1">
            {result.warnings.map((w) => (
              <li key={w} className="text-xs text-amber-700">
                {w}
              </li>
            ))}
          </ul>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="font-label inline-flex items-center justify-center rounded-md bg-gradient-brand px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-cream ring-soft transition-all hover:brightness-110 disabled:opacity-60"
        >
          {{
            idle: "Import & refresh",
            packing: "Compressing…",
            sending: "Uploading…",
            importing: "Importing…",
          }[stage]}
        </button>
      </form>
    </div>
  );
}
