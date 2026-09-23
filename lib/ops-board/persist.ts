import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyIngestMail, type IngestProposal } from "@/lib/ops-board/ingest";
import type { OpsBoardOwner } from "@/lib/ops-board/types";

/**
 * Dedup rule for ops_board_ingest_events.external_key:
 *
 * - status `created` and card_id set → return that card. Do not insert another.
 * - status `skipped` or `error`, or card_id is null (the card was deleted —
 *   ON DELETE SET NULL — or a claim never finished) → reuse this event row and
 *   allow one new card.
 *
 * A second card is never kept while card_id still points at a live row. Two
 * overlapping requests claim the row with a token in `error`; only the token
 * that is still there attaches its card. The loser deletes the card it inserted.
 */

export const INGEST_MIGRATION_MESSAGE =
  "The ingest log is not available yet. Apply supabase/migrations/0034_ops_board_ingest_events.sql if it is not applied, then try again.";

const REUSABLE = "status.eq.skipped,status.eq.error,card_id.is.null";

export type IngestReview = {
  title: string;
  nextAction: string | null;
  dueOn: string | null;
  owner: OpsBoardOwner | null;
  force: boolean;
};

export type IngestApplyInput = {
  externalKey: string;
  from: string;
  subject: string;
  bodyText: string;
  receivedAt: string | null;
  dryRun: boolean;
  /** Null on the API path, which always stores owner null and status inbox. */
  review: IngestReview | null;
};

export type IngestApplyResult = {
  externalKey: string;
  action: "create" | "skip" | "duplicate" | "error";
  cardId?: string;
  reason?: string;
  title?: string;
  suggestedOwner?: OpsBoardOwner | null;
};

type EventRow = {
  id: string;
  card_id: string | null;
  status: string;
};

type DbError = { code?: string; message?: string } | null;

type Claim =
  | { kind: "claimed"; id: string; tokenMark: string }
  | { kind: "duplicate"; cardId?: string }
  | { kind: "error"; reason: string };

export async function applyIngest(
  cards: SupabaseClient,
  events: SupabaseClient,
  input: IngestApplyInput
): Promise<IngestApplyResult> {
  const externalKey = input.externalKey.trim();
  const from = input.from.trim();
  const subject = input.subject.trim();
  const bodyText = input.bodyText;
  const receivedAt = input.receivedAt?.trim() || null;
  const proposal = classifyIngestMail({ externalKey, from, subject, bodyText, receivedAt });
  const suggestedOwner = proposal.action === "create" ? proposal.owner : null;
  const base = { externalKey, title: proposal.title, suggestedOwner };

  if (!externalKey) {
    return { ...base, action: "error", reason: "externalKey is required." };
  }

  if (input.dryRun) {
    const existing = await readEvent(events, externalKey);
    if (existing.error) return { ...base, action: "error", reason: existing.error };
    if (existing.row && isLiveCard(existing.row)) {
      return {
        ...base,
        action: "duplicate",
        cardId: existing.row.card_id ?? undefined,
        reason: "Already ingested.",
      };
    }
    if (proposal.action === "skip") {
      return { ...base, action: "skip", reason: proposal.reason };
    }
    return { ...base, action: "create", reason: proposal.ownerRationale ?? undefined };
  }

  const force = input.review?.force === true;
  if (proposal.action === "skip" && !force) {
    const skipped = await recordSkip(events, input, proposal);
    return { ...base, ...skipped, title: proposal.title, suggestedOwner: null };
  }

  const payload = buildPayload(input, proposal, force);
  const claim = await claimEvent(events, input, proposal, payload);
  if (claim.kind === "duplicate") {
    return { ...base, action: "duplicate", cardId: claim.cardId, reason: "Already ingested." };
  }
  if (claim.kind === "error") return { ...base, action: "error", reason: claim.reason };

  const appliedOwner = input.review?.owner ?? null;
  const title = clipText(input.review?.title.trim() || proposal.title, 500);
  const nextAction = input.review ? input.review.nextAction : proposal.next_action;
  const dueOn = input.review ? input.review.dueOn : proposal.due_on;
  const notes = notesFor(proposal, appliedOwner);
  const sortOrder = await nextSort(cards);

  const inserted = await cards
    .from("ops_board_items")
    .insert({
      title,
      status: "inbox",
      owner: appliedOwner,
      next_action: nextAction,
      due_on: dueOn,
      source: proposal.source.slice(0, 200),
      notes,
      sort_order: sortOrder,
    })
    .select("id")
    .single();

  if (inserted.error || !inserted.data || typeof inserted.data.id !== "string") {
    const reason = inserted.error?.message || "Could not create the card.";
    await releaseClaim(events, claim.id, claim.tokenMark, reason);
    return { ...base, action: "error", reason, title };
  }

  const cardId = inserted.data.id;
  const saved = await events
    .from("ops_board_ingest_events")
    .update({
      status: "created",
      card_id: cardId,
      error: null,
      payload,
      from_addr: from || null,
      subject: subject || null,
      received_at: asTimestamp(receivedAt),
    })
    .eq("id", claim.id)
    .eq("error", claim.tokenMark)
    .select("id");

  if (saved.error || !saved.data?.length) {
    await cards.from("ops_board_items").delete().eq("id", cardId);
    const again = await readEvent(events, externalKey);
    if (again.row && isLiveCard(again.row)) {
      return {
        ...base,
        action: "duplicate",
        cardId: again.row.card_id ?? undefined,
        reason: "Already ingested.",
        title,
      };
    }
    return {
      ...base,
      action: "error",
      reason: saved.error?.message || "Ingest key was claimed by another request.",
      title,
    };
  }

  return { ...base, action: "create", cardId, title, suggestedOwner: proposal.owner };
}

async function recordSkip(
  events: SupabaseClient,
  input: IngestApplyInput,
  proposal: IngestProposal
): Promise<Pick<IngestApplyResult, "action" | "cardId" | "reason">> {
  const row = eventFields(input, proposal, {
    status: "skipped",
    error: null,
    card_id: null,
    payload: buildPayload(input, proposal, false),
  });
  const inserted = await events.from("ops_board_ingest_events").insert(row).select("id").single();
  if (!inserted.error) return { action: "skip", reason: proposal.reason };
  if (isMissingTable(inserted.error)) return { action: "error", reason: INGEST_MIGRATION_MESSAGE };
  if (!isUnique(inserted.error)) return { action: "error", reason: inserted.error.message };

  const existing = await readEvent(events, input.externalKey.trim());
  if (existing.error) return { action: "error", reason: existing.error };
  if (existing.row && isLiveCard(existing.row)) {
    return { action: "duplicate", cardId: existing.row.card_id ?? undefined, reason: "Already ingested." };
  }

  const updated = await events
    .from("ops_board_ingest_events")
    .update(row)
    .eq("external_key", input.externalKey.trim())
    .or(REUSABLE)
    .select("id");
  if (updated.error) return { action: "error", reason: updated.error.message };
  if (!updated.data?.length) {
    const again = await readEvent(events, input.externalKey.trim());
    if (again.row && isLiveCard(again.row)) {
      return { action: "duplicate", cardId: again.row.card_id ?? undefined, reason: "Already ingested." };
    }
    return { action: "error", reason: "Could not record the skip." };
  }
  return { action: "skip", reason: proposal.reason };
}

async function claimEvent(
  events: SupabaseClient,
  input: IngestApplyInput,
  proposal: IngestProposal,
  payload: Record<string, unknown>
): Promise<Claim> {
  const tokenMark = `claim:${crypto.randomUUID()}`;
  const row = eventFields(input, proposal, {
    status: "error",
    error: tokenMark,
    card_id: null,
    payload,
  });
  const inserted = await events.from("ops_board_ingest_events").insert(row).select("id").single();
  if (!inserted.error && inserted.data && typeof inserted.data.id === "string") {
    return { kind: "claimed", id: inserted.data.id, tokenMark };
  }
  if (inserted.error && isMissingTable(inserted.error)) {
    return { kind: "error", reason: INGEST_MIGRATION_MESSAGE };
  }
  if (inserted.error && !isUnique(inserted.error)) {
    return { kind: "error", reason: inserted.error.message };
  }

  const existing = await readEvent(events, input.externalKey.trim());
  if (existing.error) return { kind: "error", reason: existing.error };
  if (!existing.row) return { kind: "error", reason: "Ingest key conflict could not be read." };
  if (isLiveCard(existing.row)) return { kind: "duplicate", cardId: existing.row.card_id ?? undefined };
  if (!canReuse(existing.row)) return { kind: "duplicate", cardId: existing.row.card_id ?? undefined };

  const updated = await events
    .from("ops_board_ingest_events")
    .update(row)
    .eq("id", existing.row.id)
    .or(REUSABLE)
    .select("id");
  if (updated.error) return { kind: "error", reason: updated.error.message };
  if (!updated.data?.length) {
    const again = await readEvent(events, input.externalKey.trim());
    if (again.row && isLiveCard(again.row)) return { kind: "duplicate", cardId: again.row.card_id ?? undefined };
    return { kind: "error", reason: "Could not claim this ingest key." };
  }
  return { kind: "claimed", id: existing.row.id, tokenMark };
}

async function releaseClaim(
  events: SupabaseClient,
  id: string,
  tokenMark: string,
  reason: string
): Promise<void> {
  await events
    .from("ops_board_ingest_events")
    .update({ status: "error", error: reason.slice(0, 500), card_id: null })
    .eq("id", id)
    .eq("error", tokenMark);
}

async function readEvent(
  events: SupabaseClient,
  externalKey: string
): Promise<{ row: EventRow | null; error: string | null }> {
  const { data, error } = await events
    .from("ops_board_ingest_events")
    .select("id, card_id, status")
    .eq("external_key", externalKey)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return { row: null, error: INGEST_MIGRATION_MESSAGE };
    return { row: null, error: error.message };
  }
  if (!data || typeof data.id !== "string") return { row: null, error: null };
  return {
    row: {
      id: data.id,
      card_id: typeof data.card_id === "string" ? data.card_id : null,
      status: typeof data.status === "string" ? data.status : "",
    },
    error: null,
  };
}

function eventFields(
  input: IngestApplyInput,
  proposal: IngestProposal,
  extra: { status: string; error: string | null; card_id: string | null; payload: Record<string, unknown> }
) {
  return {
    external_key: input.externalKey.trim(),
    direction: "in",
    from_addr: input.from.trim() || null,
    subject: input.subject.trim() || null,
    received_at: asTimestamp(input.receivedAt),
    payload: extra.payload,
    card_id: extra.card_id,
    status: extra.status,
    error: extra.error,
  };
}

function buildPayload(input: IngestApplyInput, proposal: IngestProposal, forced: boolean): Record<string, unknown> {
  return {
    mail: {
      externalKey: input.externalKey.trim(),
      from: input.from.trim(),
      subject: input.subject.trim(),
      bodyText: input.bodyText.slice(0, 20_000),
      receivedAt: input.receivedAt,
    },
    proposal,
    forced: forced && proposal.action === "skip",
    appliedOwner: input.review?.owner ?? null,
  };
}

function notesFor(proposal: IngestProposal, owner: OpsBoardOwner | null): string {
  if (!owner) return proposal.notes.slice(0, 8000);
  const who = owner === "tyler" ? "Tyler" : "Karen";
  return `${proposal.notes}\n\nStaff assigned this card to ${who} at ingest.`.slice(0, 8000);
}

async function nextSort(cards: SupabaseClient): Promise<number> {
  const { data } = await cards
    .from("ops_board_items")
    .select("sort_order")
    .eq("status", "inbox")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const max = data && typeof data.sort_order === "number" ? data.sort_order : 0;
  return max + 1;
}

function isLiveCard(row: EventRow): boolean {
  return row.status === "created" && row.card_id !== null;
}

function canReuse(row: EventRow): boolean {
  return row.status === "skipped" || row.status === "error" || row.card_id === null;
}

function isUnique(error: DbError): boolean {
  return error?.code === "23505";
}

function isMissingTable(error: DbError): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = error.message ?? "";
  return /ops_board_ingest_events/i.test(message) && /does not exist|schema cache|could not find/i.test(message);
}

function asTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function clipText(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}
