"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  isOpsBoardOwner,
  isOpsBoardStatus,
  ownerForColumnMove,
  type OpsBoardOwner,
  type OpsBoardResult,
  type OpsBoardStatus,
} from "@/lib/ops-board/types";

const PATH = "/portal/ops-board";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(e: unknown): OpsBoardResult {
  if (e instanceof Error && e.message) return { ok: false, error: e.message };
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string" && e.message) {
    return { ok: false, error: e.message };
  }
  return { ok: false, error: "Something went wrong." };
}

function blank(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function isYmd(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function parseDue(value: string | null | undefined): { ok: true; due_on: string | null } | { ok: false; error: string } {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return { ok: true, due_on: null };
  if (!isYmd(trimmed)) return { ok: false, error: "Due date must be a real calendar date." };
  return { ok: true, due_on: trimmed };
}

function parseOwner(value: unknown): OpsBoardOwner | null {
  if (value == null || value === "") return null;
  return isOpsBoardOwner(value) ? value : null;
}

type BoardRow = {
  id: string;
  status: string;
  owner: string | null;
  sort_order: number;
};

async function readItem(db: SupabaseClient, id: string): Promise<BoardRow | null> {
  const { data, error } = await db
    .from("ops_board_items")
    .select("id, status, owner, sort_order")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data || typeof data.id !== "string") return null;
  return {
    id: data.id,
    status: typeof data.status === "string" ? data.status : "",
    owner: typeof data.owner === "string" ? data.owner : null,
    sort_order: typeof data.sort_order === "number" ? data.sort_order : 0,
  };
}

async function nextSortOrder(db: SupabaseClient, status: OpsBoardStatus): Promise<number> {
  const { data, error } = await db
    .from("ops_board_items")
    .select("sort_order")
    .eq("status", status)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const max = data && typeof data.sort_order === "number" ? data.sort_order : 0;
  return max + 1;
}

export type OpsBoardDraft = {
  title: string;
  owner?: string | null;
  next_action?: string | null;
  due_on?: string | null;
  source?: string | null;
  notes?: string | null;
};

export async function createOpsBoardItem(input: OpsBoardDraft): Promise<OpsBoardResult> {
  try {
    await assertStaff();
    const db = await createClient();
    const title = blank(input.title, 500);
    if (!title) return { ok: false, error: "Title is required." };
    const due = parseDue(input.due_on);
    if (!due.ok) return due;
    const owner = parseOwner(input.owner);
    if (input.owner && !owner) return { ok: false, error: "Owner must be Tyler or Karen." };
    const sort_order = await nextSortOrder(db, "inbox");
    const { error } = await db.from("ops_board_items").insert({
      title,
      status: "inbox",
      owner,
      next_action: blank(input.next_action, 2000),
      due_on: due.due_on,
      source: blank(input.source, 200),
      notes: blank(input.notes, 8000),
      sort_order,
    });
    if (error) throw error;
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export type OpsBoardUpdate = OpsBoardDraft & {
  id: string;
  status: OpsBoardStatus;
};

export async function updateOpsBoardItem(input: OpsBoardUpdate): Promise<OpsBoardResult> {
  try {
    await assertStaff();
    const db = await createClient();
    if (!UUID.test(input.id)) return { ok: false, error: "Unknown card." };
    if (!isOpsBoardStatus(input.status)) return { ok: false, error: "Unknown column." };
    const title = blank(input.title, 500);
    if (!title) return { ok: false, error: "Title is required." };
    const due = parseDue(input.due_on);
    if (!due.ok) return due;
    if (input.owner && !isOpsBoardOwner(input.owner)) {
      return { ok: false, error: "Owner must be Tyler or Karen." };
    }

    const current = await readItem(db, input.id);
    if (!current || !isOpsBoardStatus(current.status)) {
      return { ok: false, error: "That card is no longer on the board." };
    }

    // Tyler and Karen always set the owner. Moving into Inbox clears it.
    // Staying in Inbox, Waiting, or Done keeps the owner from this edit —
    // a column move that must ignore the client goes through moveOpsBoardItem.
    const owner: OpsBoardOwner | null =
      input.status === "tyler" || input.status === "karen"
        ? input.status
        : input.status === "inbox" && current.status !== "inbox"
          ? null
          : parseOwner(input.owner);

    const sort_order =
      current.status === input.status ? current.sort_order : await nextSortOrder(db, input.status);

    const { error } = await db
      .from("ops_board_items")
      .update({
        title,
        status: input.status,
        owner,
        next_action: blank(input.next_action, 2000),
        due_on: due.due_on,
        source: blank(input.source, 200),
        notes: blank(input.notes, 8000),
        sort_order,
      })
      .eq("id", input.id);
    if (error) throw error;
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Column move. Owner is derived here; the client cannot send one. */
export async function moveOpsBoardItem(id: string, status: OpsBoardStatus): Promise<OpsBoardResult> {
  try {
    await assertStaff();
    const db = await createClient();
    if (!UUID.test(id)) return { ok: false, error: "Unknown card." };
    if (!isOpsBoardStatus(status)) return { ok: false, error: "Unknown column." };

    const current = await readItem(db, id);
    if (!current || !isOpsBoardStatus(current.status)) {
      return { ok: false, error: "That card is no longer on the board." };
    }
    if (current.status === status) return { ok: true };

    const owner = ownerForColumnMove(status, parseOwner(current.owner));
    const sort_order = await nextSortOrder(db, status);
    const { error } = await db.from("ops_board_items").update({ status, owner, sort_order }).eq("id", id);
    if (error) throw error;
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteOpsBoardItem(id: string): Promise<OpsBoardResult> {
  try {
    await assertStaff();
    const db = await createClient();
    if (!UUID.test(id)) return { ok: false, error: "Unknown card." };
    const { error } = await db.from("ops_board_items").delete().eq("id", id);
    if (error) throw error;
    revalidatePath(PATH);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
