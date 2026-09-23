// Shared by the staff Ops Board page and its client board. Not server-only:
// the Kanban component imports the column order and the move rules so optimistic
// updates match the server action. The action is still what gets written.

export const OPS_BOARD_STATUSES = ["inbox", "tyler", "karen", "waiting", "done"] as const;
export type OpsBoardStatus = (typeof OPS_BOARD_STATUSES)[number];

export const OPS_BOARD_OWNERS = ["tyler", "karen"] as const;
export type OpsBoardOwner = (typeof OPS_BOARD_OWNERS)[number];

/** Arizona has no DST. Due dates are calendar dates, compared in this zone. */
export const OPS_BOARD_TZ = "America/Phoenix";

export const OPS_BOARD_COLUMNS: readonly { status: OpsBoardStatus; label: string }[] = [
  { status: "inbox", label: "Inbox" },
  { status: "tyler", label: "Tyler" },
  { status: "karen", label: "Karen" },
  { status: "waiting", label: "Waiting" },
  { status: "done", label: "Done" },
];

export const OPS_BOARD_OWNER_LABEL: Record<OpsBoardOwner, string> = {
  tyler: "Tyler",
  karen: "Karen",
};

export type OpsBoardItem = {
  id: string;
  title: string;
  status: OpsBoardStatus;
  owner: OpsBoardOwner | null;
  next_action: string | null;
  due_on: string | null;
  source: string | null;
  notes: string | null;
  sort_order: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OpsBoardResult = { ok: true } | { ok: false; error: string };

export type OpsBoardIngestStatus = "created" | "skipped" | "error";

export type OpsBoardIngestEvent = {
  id: string;
  external_key: string;
  from_addr: string | null;
  subject: string | null;
  status: OpsBoardIngestStatus;
  card_id: string | null;
  error: string | null;
  created_at: string;
};

export function isOpsBoardIngestStatus(v: unknown): v is OpsBoardIngestStatus {
  return v === "created" || v === "skipped" || v === "error";
}

export function isOpsBoardStatus(v: unknown): v is OpsBoardStatus {
  return typeof v === "string" && (OPS_BOARD_STATUSES as readonly string[]).includes(v);
}

export function isOpsBoardOwner(v: unknown): v is OpsBoardOwner {
  return typeof v === "string" && (OPS_BOARD_OWNERS as readonly string[]).includes(v);
}

/**
 * Owner that a column move must persist. Inbox clears it, Tyler and Karen set
 * it, Waiting and Done keep whoever already owns the card. Callers must not
 * substitute a client-supplied owner for a move.
 */
export function ownerForColumnMove(
  status: OpsBoardStatus,
  currentOwner: OpsBoardOwner | null
): OpsBoardOwner | null {
  if (status === "inbox") return null;
  if (status === "tyler") return "tyler";
  if (status === "karen") return "karen";
  return currentOwner;
}

export function phoenixToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OPS_BOARD_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format a YYYY-MM-DD date without constructing a Date (which would shift the day). */
export function formatBoardDate(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return ymd;
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!month || !day) return ymd;
  return `${month} ${day}, ${match[1]}`;
}

export function isOverdue(item: Pick<OpsBoardItem, "due_on" | "status">, today = phoenixToday()): boolean {
  return item.status !== "done" && item.due_on !== null && item.due_on < today;
}

export function parseOpsBoardItem(row: unknown): OpsBoardItem | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.title !== "string") return null;
  if (!isOpsBoardStatus(r.status)) return null;
  if (typeof r.created_at !== "string" || typeof r.updated_at !== "string") return null;
  const sort = typeof r.sort_order === "number" ? r.sort_order : Number(r.sort_order);
  if (!Number.isFinite(sort)) return null;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    owner: isOpsBoardOwner(r.owner) ? r.owner : null,
    next_action: typeof r.next_action === "string" && r.next_action.trim() ? r.next_action : null,
    due_on: typeof r.due_on === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.due_on) ? r.due_on.slice(0, 10) : null,
    source: typeof r.source === "string" && r.source.trim() ? r.source : null,
    notes: typeof r.notes === "string" && r.notes.trim() ? r.notes : null,
    sort_order: sort,
    completed_at: typeof r.completed_at === "string" ? r.completed_at : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function parseOpsBoardIngestEvent(row: unknown): OpsBoardIngestEvent | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.external_key !== "string") return null;
  if (!isOpsBoardIngestStatus(r.status) || typeof r.created_at !== "string") return null;
  return {
    id: r.id,
    external_key: r.external_key,
    from_addr: typeof r.from_addr === "string" && r.from_addr.trim() ? r.from_addr : null,
    subject: typeof r.subject === "string" && r.subject.trim() ? r.subject : null,
    status: r.status,
    card_id: typeof r.card_id === "string" ? r.card_id : null,
    error: typeof r.error === "string" && r.error.trim() ? r.error : null,
    created_at: r.created_at,
  };
}
