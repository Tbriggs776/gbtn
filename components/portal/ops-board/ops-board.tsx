"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, ErrorText, Field, Modal, Select, TextArea, TextInput } from "@/components/portal/crm/ui";
import {
  createOpsBoardItem,
  deleteOpsBoardItem,
  ingestOpsBoardEmail,
  moveOpsBoardItem,
  updateOpsBoardItem,
} from "@/app/portal/ops-board/actions";
import { IngestEmailModal, type IngestEmailDraft } from "@/components/portal/ops-board/ingest-email";
import {
  OPS_BOARD_COLUMNS,
  OPS_BOARD_OWNER_LABEL,
  formatBoardDate,
  isOpsBoardStatus,
  isOverdue,
  ownerForColumnMove,
  phoenixToday,
  type OpsBoardIngestEvent,
  type OpsBoardItem,
  type OpsBoardOwner,
  type OpsBoardStatus,
} from "@/lib/ops-board/types";

type Draft = {
  title: string;
  status: OpsBoardStatus;
  owner: OpsBoardOwner | "";
  next_action: string;
  due_on: string;
  source: string;
  notes: string;
};

const EMPTY_DRAFT: Draft = {
  title: "",
  status: "inbox",
  owner: "",
  next_action: "",
  due_on: "",
  source: "",
  notes: "",
};

function draftFrom(item: OpsBoardItem): Draft {
  return {
    title: item.title,
    status: item.status,
    owner: item.owner ?? "",
    next_action: item.next_action ?? "",
    due_on: item.due_on ?? "",
    source: item.source ?? "",
    notes: item.notes ?? "",
  };
}

function completedLabel(iso: string): string {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return `Completed ${formatBoardDate(ymd)}`;
}

export function OpsBoard({
  items,
  ingestEvents = [],
}: {
  items: OpsBoardItem[];
  ingestEvents?: OpsBoardIngestEvent[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(items);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<OpsBoardStatus | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [createKey, setCreateKey] = useState(0);
  const [createSeed, setCreateSeed] = useState<Draft>(EMPTY_DRAFT);
  const [ingesting, setIngesting] = useState(false);
  const [ingestKey, setIngestKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<OpsBoardItem | null>(null);
  const today = phoenixToday();

  useEffect(() => setLocal(items), [items]);

  const inColumn = (status: OpsBoardStatus) => local.filter((item) => item.status === status);

  function applyMove(id: string, status: OpsBoardStatus) {
    const current = local.find((item) => item.id === id);
    if (!current || current.status === status) return;
    const snapshot = local;
    const max = local
      .filter((item) => item.status === status && item.id !== id)
      .reduce((m, item) => Math.max(m, item.sort_order), 0);
    setLocal((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              status,
              owner: ownerForColumnMove(status, item.owner),
              sort_order: max + 1,
              completed_at: status === "done" ? item.completed_at ?? new Date().toISOString() : null,
            }
          : item
      )
    );
    setError("");
    start(async () => {
      const res = await moveOpsBoardItem(id, status);
      if (!res.ok) {
        setLocal(snapshot);
        setError(res.error);
      }
      router.refresh();
    });
  }

  function drop(status: OpsBoardStatus) {
    setOver(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    applyMove(id, status);
  }

  function submitIngest(draft: IngestEmailDraft) {
    const snapshot = local;
    const tempId = `temp-${crypto.randomUUID()}`;
    const max = local
      .filter((item) => item.status === "inbox")
      .reduce((m, item) => Math.max(m, item.sort_order), 0);
    const optimistic: OpsBoardItem = {
      id: tempId,
      title: draft.title.trim(),
      status: "inbox",
      owner: draft.owner || null,
      next_action: draft.next_action.trim() || null,
      due_on: draft.due_on || null,
      source: draft.subject.trim() ? `email: ${draft.subject.trim()}` : null,
      notes: null,
      sort_order: max + 1,
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setLocal((prev) => [...prev, optimistic]);
    setIngesting(false);
    setError("");
    setNotice("");
    start(async () => {
      const res = await ingestOpsBoardEmail(draft);
      if (!res.ok) {
        setLocal(snapshot);
        setIngesting(true);
        setError(res.error);
      } else if (res.duplicate) {
        setLocal(snapshot);
        setNotice("That email is already on the board.");
      }
      router.refresh();
    });
  }

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {pending ? "Saving…" : "Drag a card, or use Move to. Inbox clears the owner."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setError("");
              setNotice("");
              setIngestKey((key) => key + 1);
              setIngesting(true);
            }}
          >
            Ingest email
          </Button>
          <Button
            onClick={() => {
              setCreateSeed(EMPTY_DRAFT);
              setCreateKey((key) => key + 1);
              setCreating(true);
            }}
          >
            + New card
          </Button>
        </div>
      </div>
      {notice ? <p className="mt-3 text-sm text-muted">{notice}</p> : null}
      {error ? (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      ) : null}

      {ingestEvents.length > 0 ? (
        <RecentIngest
          events={ingestEvents}
          items={local}
          onOpen={(id) => {
            const item = local.find((card) => card.id === id);
            if (item) setEditing(item);
          }}
        />
      ) : null}

      <div className="mt-4 flex gap-4 overflow-x-auto pb-4">
        {OPS_BOARD_COLUMNS.map((column) => {
          const cards = inColumn(column.status);
          return (
            <div
              key={column.status}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(column.status);
              }}
              onDrop={() => drop(column.status)}
              className={`flex w-72 shrink-0 flex-col rounded-2xl border bg-paper-soft/60 p-3 ${
                over === column.status ? "border-brand-700" : "border-line"
              }`}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-sm font-bold text-ink">{column.label}</span>
                <span className="text-xs text-muted-soft">{cards.length}</span>
              </div>
              <div className="flex min-h-40 flex-col gap-2">
                {cards.map((item) => (
                  <Card
                    key={item.id}
                    item={item}
                    today={today}
                    onDragStart={() => setDragId(item.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setOver(null);
                    }}
                    onMove={(status) => applyMove(item.id, status)}
                    onEdit={() => setEditing(item)}
                    onComplete={() => applyMove(item.id, "done")}
                  />
                ))}
                {cards.length === 0 ? (
                  <p className="px-1 py-4 text-center text-xs text-muted-soft">Drop cards here</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <IngestEmailModal
        key={`ingest-${ingestKey}`}
        open={ingesting}
        pending={pending}
        serverError={error}
        onClose={() => setIngesting(false)}
        onSubmit={(draft) => submitIngest(draft)}
      />

      <CardModal
        key={`new-${createKey}`}
        open={creating}
        title="New card"
        initial={createSeed}
        allowStatus={false}
        pending={pending}
        onClose={() => setCreating(false)}
        onSubmit={(draft) => {
          const snapshot = local;
          const tempId = `temp-${crypto.randomUUID()}`;
          const max = local
            .filter((item) => item.status === "inbox")
            .reduce((m, item) => Math.max(m, item.sort_order), 0);
          const optimistic: OpsBoardItem = {
            id: tempId,
            title: draft.title.trim(),
            status: "inbox",
            owner: draft.owner || null,
            next_action: draft.next_action.trim() || null,
            due_on: draft.due_on || null,
            source: draft.source.trim() || null,
            notes: draft.notes.trim() || null,
            sort_order: max + 1,
            completed_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          setLocal((prev) => [...prev, optimistic]);
          setCreating(false);
          setError("");
          start(async () => {
            const res = await createOpsBoardItem(draft);
            if (!res.ok) {
              setLocal(snapshot);
              setCreateSeed(draft);
              setCreateKey((key) => key + 1);
              setCreating(true);
              setError(res.error);
            }
            router.refresh();
          });
        }}
      />

      <CardModal
        key={editing?.id ?? "edit-closed"}
        open={!!editing}
        title="Edit card"
        initial={editing ? draftFrom(editing) : EMPTY_DRAFT}
        allowStatus
        pending={pending}
        onClose={() => setEditing(null)}
        onSubmit={(draft) => {
          if (!editing) return;
          const snapshot = local;
          const id = editing.id;
          const statusChanged = editing.status !== draft.status;
          const max = local
            .filter((item) => item.status === draft.status && item.id !== id)
            .reduce((m, item) => Math.max(m, item.sort_order), 0);
          const owner: OpsBoardOwner | null =
            draft.status === "tyler" || draft.status === "karen"
              ? draft.status
              : draft.status === "inbox" && editing.status !== "inbox"
                ? null
                : draft.owner || null;
          setLocal((prev) =>
            prev.map((item) =>
              item.id === id
                ? {
                    ...item,
                    title: draft.title.trim(),
                    status: draft.status,
                    owner,
                    next_action: draft.next_action.trim() || null,
                    due_on: draft.due_on || null,
                    source: draft.source.trim() || null,
                    notes: draft.notes.trim() || null,
                    sort_order: statusChanged ? max + 1 : item.sort_order,
                    completed_at:
                      draft.status === "done"
                        ? item.completed_at ?? new Date().toISOString()
                        : null,
                  }
                : item
            )
          );
          setEditing(null);
          setError("");
          start(async () => {
            const res = await updateOpsBoardItem({ id, ...draft, owner: draft.owner || null });
            if (!res.ok) {
              setLocal(snapshot);
              setError(res.error);
            }
            router.refresh();
          });
        }}
        onDelete={
          editing
            ? () => {
                const snapshot = local;
                const id = editing.id;
                setLocal((prev) => prev.filter((item) => item.id !== id));
                setEditing(null);
                setError("");
                start(async () => {
                  const res = await deleteOpsBoardItem(id);
                  if (!res.ok) {
                    setLocal(snapshot);
                    setError(res.error);
                  }
                  router.refresh();
                });
              }
            : undefined
        }
      />
    </>
  );
}

function RecentIngest({
  events,
  items,
  onOpen,
}: {
  events: OpsBoardIngestEvent[];
  items: OpsBoardItem[];
  onOpen: (cardId: string) => void;
}) {
  const onBoard = new Set(items.map((item) => item.id));
  return (
    <div className="mt-4 rounded-2xl border border-line bg-white px-4 py-3">
      <p className="text-xs font-semibold text-muted">Recent ingest</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {events.map((event) => {
          const label = event.subject || event.from_addr || event.external_key;
          const cardId = event.card_id;
          const canOpen = cardId !== null && onBoard.has(cardId);
          return (
            <li key={event.id} className="flex items-center justify-between gap-3 text-sm">
              {canOpen && cardId ? (
                <button
                  type="button"
                  onClick={() => onOpen(cardId)}
                  className="min-w-0 truncate text-left font-medium text-brand-700 hover:underline"
                >
                  {label}
                </button>
              ) : (
                <span className="min-w-0 truncate text-ink">{label}</span>
              )}
              <Badge tone={event.status === "created" ? "green" : event.status === "error" ? "red" : "neutral"}>
                {event.status}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Card({
  item,
  today,
  onDragStart,
  onDragEnd,
  onMove,
  onEdit,
  onComplete,
}: {
  item: OpsBoardItem;
  today: string;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (status: OpsBoardStatus) => void;
  onEdit: () => void;
  onComplete: () => void;
}) {
  const overdue = isOverdue(item, today);
  return (
    <article
      draggable
      onDragStart={(e) => {
        if ((e.target as HTMLElement).closest("button, select, a, label")) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`cursor-grab rounded-xl border border-line bg-white p-3 ring-soft active:cursor-grabbing ${
        item.status === "done" ? "opacity-80" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
        {item.owner ? (
          <Badge tone={item.owner === "tyler" ? "blue" : "amber"}>{OPS_BOARD_OWNER_LABEL[item.owner]}</Badge>
        ) : (
          <Badge>Unassigned</Badge>
        )}
      </div>
      {item.next_action ? (
        <p className="mt-2 text-sm text-ink">
          <span className="text-muted-soft">Next · </span>
          {item.next_action}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {item.due_on ? (
          <span className={overdue ? "font-semibold text-red-700" : "text-muted"}>
            Due {formatBoardDate(item.due_on)}
            {overdue ? " · Overdue" : ""}
          </span>
        ) : null}
        {item.source ? <span className="text-muted-soft">{item.source}</span> : null}
      </div>
      {item.notes ? <p className="mt-2 line-clamp-2 text-xs text-muted-soft">{item.notes}</p> : null}
      {item.status === "done" && item.completed_at ? (
        <p className="mt-2 text-[11px] text-muted-soft">{completedLabel(item.completed_at)}</p>
      ) : null}
      <div className="mt-3 flex items-center gap-2 border-t border-line/60 pt-2">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium text-muted">
          <span className="shrink-0">Move to</span>
          <select
            aria-label={`Move ${item.title}`}
            value={item.status}
            onChange={(e) => {
              if (isOpsBoardStatus(e.target.value)) onMove(e.target.value);
            }}
            className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink outline-none focus:border-brand-700"
          >
            {OPS_BOARD_COLUMNS.map((column) => (
              <option key={column.status} value={column.status}>
                {column.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onEdit} className="text-xs font-semibold text-brand-700 hover:underline">
          Edit
        </button>
      </div>
      {item.status !== "done" ? (
        <button
          type="button"
          onClick={onComplete}
          className="mt-2 text-xs font-semibold text-brand-700 hover:underline"
        >
          Complete
        </button>
      ) : null}
    </article>
  );
}

function CardModal({
  open,
  title,
  initial,
  allowStatus,
  pending,
  onClose,
  onSubmit,
  onDelete,
}: {
  open: boolean;
  title: string;
  initial: Draft;
  allowStatus: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (draft: Draft) => void;
  onDelete?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [formError, setFormError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Tyler and Karen own the column. Inbox only clears the owner when the
  // card is moved there; a new card can still name one.
  const ownerLocked = draft.status === "tyler" || draft.status === "karen";

  function setStatus(status: OpsBoardStatus) {
    setDraft((prev) => ({
      ...prev,
      status,
      owner:
        status === "waiting" || status === "done"
          ? prev.owner
          : (ownerForColumnMove(status, prev.owner || null) ?? ""),
    }));
  }

  function submit() {
    if (!draft.title.trim()) {
      setFormError("Title is required.");
      return;
    }
    setFormError("");
    onSubmit(draft);
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-3">
        <Field label="Title">
          <TextInput
            value={draft.title}
            onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
            placeholder="What needs doing"
            autoFocus
          />
        </Field>
        {allowStatus ? (
          <Field label="Column">
            <Select
              value={draft.status}
              onChange={(e) => {
                if (isOpsBoardStatus(e.target.value)) setStatus(e.target.value);
              }}
            >
              {OPS_BOARD_COLUMNS.map((column) => (
                <option key={column.status} value={column.status}>
                  {column.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-xs text-muted-soft">New cards start in Inbox.</p>
        )}
        <Field
          label="Owner"
          hint={
            !allowStatus
              ? "Optional. A later move to Inbox clears it; Tyler or Karen sets it."
              : ownerLocked
                ? "This column sets the owner."
                : draft.status === "inbox"
                  ? "Moving a card to Inbox clears the owner. Staying here keeps it."
                  : "Waiting and Done keep the owner you set here."
          }
        >
          <Select
            value={ownerLocked ? (ownerForColumnMove(draft.status, draft.owner || null) ?? "") : draft.owner}
            disabled={ownerLocked}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                owner: e.target.value === "tyler" || e.target.value === "karen" ? e.target.value : "",
              }))
            }
          >
            <option value="">Unassigned</option>
            <option value="tyler">Tyler</option>
            <option value="karen">Karen</option>
          </Select>
        </Field>
        <Field label="Next action">
          <TextInput
            value={draft.next_action}
            onChange={(e) => setDraft((prev) => ({ ...prev, next_action: e.target.value }))}
          />
        </Field>
        <Field label="Due">
          <TextInput
            type="date"
            value={draft.due_on}
            onChange={(e) => setDraft((prev) => ({ ...prev, due_on: e.target.value }))}
          />
        </Field>
        <Field label="Source">
          <TextInput
            value={draft.source}
            onChange={(e) => setDraft((prev) => ({ ...prev, source: e.target.value }))}
            placeholder="Where this came from"
          />
        </Field>
        <Field label="Notes">
          <TextArea
            value={draft.notes}
            onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))}
          />
        </Field>
        <ErrorText>{formError}</ErrorText>
        <div className="flex items-center justify-between gap-2">
          {onDelete ? (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <Button type="button" variant="danger" size="sm" disabled={pending} onClick={onDelete}>
                  Delete card
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </div>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={pending} onClick={submit}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
