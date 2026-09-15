"use client";

import type React from "react";
import { fieldPercentStyle } from "@/lib/esign/geometry";
import type { FieldRect } from "@/lib/esign/types";

// One field rectangle over a rendered page, positioned in percent of the
// displayed page (fieldPercentStyle), so zoom and resize never touch field
// state. "mine" = this signer's box (brand outline + chip), "other" = another
// signer's box (grey dashed), "done" = another signer's box they've signed.
// Never draws other signers' names or images. The signer page uses this; the
// staff wizard has its own editable FieldBox.

type Tone = "mine" | "other" | "done";

const BOX: Record<Tone, string> = {
  mine: "border-2 border-navy bg-brand-50/60",
  other: "border border-dashed border-muted-soft bg-paper-soft/40",
  done: "border-2 border-emerald-600 bg-emerald-50/40",
};

const CHIP: Record<Tone, string> = {
  mine: "bg-navy text-cream",
  other: "border border-line bg-white text-muted",
  done: "bg-emerald-700 text-white",
};

export function FieldOutline({
  rect,
  tone,
  label,
  onActivate,
  focusable = true,
  children,
  id,
  pressed,
}: {
  rect: FieldRect;
  tone: Tone;
  label: string;
  onActivate?: () => void;
  focusable?: boolean;
  children?: React.ReactNode;
  /** DOM id, so the sticky bar can scroll to and focus this box. */
  id?: string;
  /** Toggle state for an activatable box (a signature applied to it). */
  pressed?: boolean;
}): React.JSX.Element {
  const style = fieldPercentStyle(rect);
  const content = (
    <>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-full left-0 mb-0.5 max-w-[14rem] truncate rounded px-1.5 font-label text-[10px] font-semibold uppercase leading-4 tracking-[0.12em] ${CHIP[tone]}`}
      >
        {label}
      </span>
      {/* container-type lets children size their text in cqh/cqw of the box. */}
      <span
        className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
        style={{ containerType: "size" }}
      >
        {children}
      </span>
    </>
  );

  if (onActivate) {
    return (
      <button
        id={id}
        type="button"
        onClick={onActivate}
        tabIndex={focusable ? 0 : -1}
        aria-label={label}
        aria-pressed={pressed}
        style={style}
        className={`absolute rounded-[3px] ${BOX[tone]} ${
          pressed ? "bg-white/30" : "hover:bg-brand-100/70"
        } cursor-pointer transition-colors before:absolute before:-inset-2 before:content-[''] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1`}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      tabIndex={focusable ? 0 : undefined}
      style={style}
      className={`pointer-events-none absolute rounded-[3px] ${BOX[tone]}`}
    >
      {content}
    </div>
  );
}
