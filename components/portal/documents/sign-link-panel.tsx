"use client";

import { useRef, useState } from "react";

/**
 * The one-time signing link: a read-only field, Copy link, and the warning.
 * Shared by the send wizard's result screen and the Resend / Send link now
 * notice in the documents table.
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
