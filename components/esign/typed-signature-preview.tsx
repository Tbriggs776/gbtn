"use client";

import { useEffect, useState } from "react";
import type React from "react";
import { greatVibes } from "@/components/esign/signature-font";
import { normalizeSignerText } from "@/lib/esign/types";

// A typed signature as the signer will see it stamped. The server draws the
// same NORMALIZED text (normalizeSignerText) in the same Great Vibes face, so
// the preview normalizes identically and stays invisible until the face has
// loaded — never a flash of a fallback font the seal won't use.

const FONT_WAIT_MS = 3_000;

export function TypedSignaturePreview({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.JSX.Element {
  const normalized = normalizeSignerText(text);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!fonts || typeof fonts.load !== "function") {
      setReady(true);
      return;
    }
    // Never hide the preview forever on a slow or blocked font load.
    const timer = window.setTimeout(() => {
      if (alive) setReady(true);
    }, FONT_WAIT_MS);
    const done = () => {
      if (alive) setReady(true);
    };
    // Passing the text loads the unicode-range subsets it needs (Cyrillic, Greek…).
    fonts.load(`48px ${greatVibes.style.fontFamily}`, normalized || "Signature").then(done, done);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [normalized]);

  return (
    <span className={`${greatVibes.className} ${ready ? "" : "invisible"} ${className ?? ""}`}>
      {normalized}
    </span>
  );
}
