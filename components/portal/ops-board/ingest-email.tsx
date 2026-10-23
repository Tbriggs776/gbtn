"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, ErrorText, Field, Modal, Select, TextArea, TextInput } from "@/components/portal/crm/ui";
import { classifyIngestMail, hashIngestKey, splitPastedEmail } from "@/lib/ops-board/ingest";
import { OPS_BOARD_OWNER_LABEL, type OpsBoardOwner } from "@/lib/ops-board/types";

export type IngestEmailDraft = {
  from: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
  externalKey: string;
  title: string;
  next_action: string;
  due_on: string;
  owner: OpsBoardOwner | "";
  force: boolean;
};

export function IngestEmailModal({
  open,
  pending,
  serverError = "",
  onClose,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  serverError?: string;
  onClose: () => void;
  onSubmit: (draft: IngestEmailDraft) => void;
}) {
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [externalKey, setExternalKey] = useState("");
  const [hashedKey, setHashedKey] = useState("");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [nextAction, setNextAction] = useState("");
  const [nextTouched, setNextTouched] = useState(false);
  const [dueOn, setDueOn] = useState("");
  const [dueTouched, setDueTouched] = useState(false);
  const [owner, setOwner] = useState<OpsBoardOwner | "">("");
  const [ownerTouched, setOwnerTouched] = useState(false);
  const [force, setForce] = useState(false);
  const [formError, setFormError] = useState("");

  const resolvedKey = externalKey.trim() || hashedKey;

  useEffect(() => {
    if (externalKey.trim()) {
      setHashedKey("");
      return;
    }
    let cancelled = false;
    hashIngestKey(from, subject, receivedAt).then((key) => {
      if (!cancelled) setHashedKey(key);
    });
    return () => {
      cancelled = true;
    };
  }, [from, subject, receivedAt, externalKey]);

  const proposal = useMemo(
    () =>
      classifyIngestMail({
        externalKey: resolvedKey,
        from,
        subject,
        bodyText,
        receivedAt,
      }),
    [resolvedKey, from, subject, bodyText, receivedAt]
  );

  const displayTitle = titleTouched ? title : proposal.title;
  const displayNext = nextTouched ? nextAction : (proposal.next_action ?? "");
  const displayDue = dueTouched ? dueOn : (proposal.due_on ?? "");
  const suggestedOwner = proposal.ownerConfidence === "high" ? proposal.owner : null;
  const displayOwner = ownerTouched ? owner : (suggestedOwner ?? "");
  const blocked = proposal.action === "skip" && !force;

  function fillFromDump() {
    const split = splitPastedEmail(bodyText);
    if (!split) {
      setFormError("Could not find From and Subject lines in that paste.");
      return;
    }
    setFormError("");
    setFrom(split.from);
    setSubject(split.subject);
    setBodyText(split.bodyText);
    if (split.receivedAt) setReceivedAt(split.receivedAt);
    setTitleTouched(false);
    setNextTouched(false);
    setDueTouched(false);
    setOwnerTouched(false);
  }

  function submit() {
    if (!displayTitle.trim()) {
      setFormError("Title is required.");
      return;
    }
    if (!resolvedKey) {
      setFormError("External key is still being generated.");
      return;
    }
    if (blocked) {
      setFormError(proposal.reason ?? "This email does not look like ops work.");
      return;
    }
    setFormError("");
    onSubmit({
      from,
      subject,
      bodyText,
      receivedAt,
      externalKey: resolvedKey,
      title: displayTitle,
      next_action: displayNext,
      due_on: displayDue,
      owner: displayOwner,
      force,
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Ingest email" wide>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          Paste a Floor Daddy ops email. It lands in Inbox. A repeated key does not create a second card.
        </p>
        <Field label="From">
          <TextInput value={from} onChange={(e) => setFrom(e.target.value)} placeholder="name@floordaddy.com" autoFocus />
        </Field>
        <Field label="Subject">
          <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Body" hint="Or paste a forwarded message, then split it into these fields.">
          <TextArea value={bodyText} onChange={(e) => setBodyText(e.target.value)} className="min-h-[140px]" />
        </Field>
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={fillFromDump}>
            Split pasted email
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Received" hint="Optional. Used in the dedupe key when you leave External key blank.">
            <TextInput type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          </Field>
          <Field label="External key" hint="Blank uses a hash of from, subject, and date.">
            <TextInput
              value={externalKey}
              onChange={(e) => setExternalKey(e.target.value)}
              placeholder={hashedKey ? hashedKey.slice(0, 16) : "Generating…"}
            />
          </Field>
        </div>

        <div className="rounded-xl border border-line bg-paper-soft/60 p-3">
          <p className="text-xs font-semibold text-muted">Proposal</p>
          {proposal.action === "skip" ? (
            <p className="mt-2 text-sm font-medium text-amber-800">Skip — {proposal.reason}</p>
          ) : (
            <p className="mt-2 text-sm text-ink">Create an Inbox card.</p>
          )}
          <p className="mt-1 text-xs text-muted-soft">
            {proposal.owner
              ? `Suggested owner: ${OPS_BOARD_OWNER_LABEL[proposal.owner]}${
                  proposal.ownerRationale ? ` — ${proposal.ownerRationale}` : ""
                }`
              : "Suggested owner: none"}
          </p>
          <p className="mt-1 break-all text-[11px] text-muted-soft">Key {resolvedKey || "…"}</p>
        </div>

        <Field label="Title">
          <TextInput
            value={displayTitle}
            onChange={(e) => {
              setTitleTouched(true);
              setTitle(e.target.value);
            }}
          />
        </Field>
        <Field label="Next action">
          <TextInput
            value={displayNext}
            onChange={(e) => {
              setNextTouched(true);
              setNextAction(e.target.value);
            }}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Due">
            <TextInput
              type="date"
              value={displayDue}
              onChange={(e) => {
                setDueTouched(true);
                setDueOn(e.target.value);
              }}
            />
          </Field>
          <Field
            label="Owner"
            hint={
              proposal.owner && proposal.ownerConfidence !== "high"
                ? `Suggestion only: ${OPS_BOARD_OWNER_LABEL[proposal.owner]}. Inbox stays unassigned unless you pick someone.`
                : "Inbox stays unassigned unless you pick someone."
            }
          >
            <Select
              value={displayOwner}
              onChange={(e) => {
                setOwnerTouched(true);
                setOwner(e.target.value === "tyler" || e.target.value === "karen" ? e.target.value : "");
              }}
            >
              <option value="">Unassigned</option>
              <option value="tyler">Tyler</option>
              <option value="karen">Karen</option>
            </Select>
          </Field>
        </div>
        {proposal.action === "skip" ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Create anyway
          </label>
        ) : null}
        <ErrorText>{formError || serverError}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={pending || blocked || !resolvedKey} onClick={submit}>
            Create in Inbox
          </Button>
        </div>
      </div>
    </Modal>
  );
}
