// The permission model, in one place.
//
// Two independent axes:
//
//   1. PLATFORM ADMIN — profiles.role = 'admin'. That's GBTN staff (Tyler).
//      Sees every client and every capability, everywhere. Unchanged by this
//      module; it short-circuits every check.
//
//   2. CLIENT ROLE — memberships.role, PER CLIENT. A person can be 'finance'
//      at one company and 'ops' at another. This is what the four roles below
//      describe, and it only ever grants access to the client it's attached to.
//
// Deliberately dependency-free and NOT server-only: the sidebar (a client
// component) and the server guards must agree on exactly one matrix, or the UI
// will offer links that the server then refuses.

export const CLIENT_ROLES = ["admin", "finance", "ops", "marketing"] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];

export const ROLE_LABEL: Record<ClientRole, string> = {
  admin: "Admin",
  finance: "Finance",
  ops: "Ops",
  marketing: "Marketing",
};

export const ROLE_BLURB: Record<ClientRole, string> = {
  admin: "Everything, plus manages this company's users",
  finance: "Everything, including financials",
  ops: "Operations — no financials or marketing",
  marketing: "Everything except financials",
};

/**
 * Capabilities, not tabs. Tabs come and go; these are the things a role is
 * actually allowed to do, and every gate in the app resolves to one of them.
 */
export type Capability =
  /** The Financials tab, and Financials-category documents. */
  | "financials"
  /** Marketing, Google Ads, and the marketing-connection Settings tab. */
  | "marketing"
  /** Ops Reports, Operational Levers, Pricing. */
  | "ops"
  /** The Documents tab at all (category filtering is separate). */
  | "documents"
  /** Invite/edit/remove users and set their roles — scoped to this client. */
  | "manage_users";

const MATRIX: Record<ClientRole, readonly Capability[]> = {
  admin: ["financials", "marketing", "ops", "documents", "manage_users"],
  finance: ["financials", "marketing", "ops", "documents"],
  // Ops keeps Pricing and Operational Levers (day-to-day operating tools) even
  // though they surface margin; the Financials tab and financial documents are
  // what's withheld.
  ops: ["ops", "documents"],
  marketing: ["marketing", "ops", "documents"],
};

/** Does this client-role grant the capability? Platform admin is handled by the caller. */
export function roleCan(role: ClientRole | null | undefined, cap: Capability): boolean {
  if (!role) return false;
  const caps = MATRIX[role];
  return caps ? caps.includes(cap) : false;
}

export function isClientRole(v: unknown): v is ClientRole {
  return typeof v === "string" && (CLIENT_ROLES as readonly string[]).includes(v);
}

/**
 * Resolve a stored membership role. Legacy rows carry the pre-roles default
 * 'member'; those are treated as 'finance' (the migration's backfill), so a
 * stale row can never silently become a no-access account.
 */
export function normalizeRole(v: unknown): ClientRole {
  return isClientRole(v) ? v : "finance";
}

// ── Navigation ───────────────────────────────────────────────────────────────

export type NavKey =
  | "overview" | "documents" | "financials" | "marketing" | "googleAds"
  | "opsReports" | "levers" | "pricing" | "settings" | "account" | "admin";

/** null = always visible to anyone with access to the client. */
export const NAV_CAPABILITY: Record<NavKey, Capability | null> = {
  overview: null,
  documents: "documents",
  financials: "financials",
  marketing: "marketing",
  googleAds: "marketing",
  opsReports: "ops",
  levers: "ops",
  pricing: "ops",
  settings: "marketing", // configures the marketing/CallRail connections
  account: null,
  admin: "manage_users",
};

export function canSeeNav(
  key: NavKey,
  role: ClientRole | null | undefined,
  isPlatformAdmin: boolean
): boolean {
  if (isPlatformAdmin) return true;
  const cap = NAV_CAPABILITY[key];
  if (cap === null) return Boolean(role);
  return roleCan(role, cap);
}

// ── Documents ────────────────────────────────────────────────────────────────

/**
 * Financial packages live in the Documents tab under the 'Financials' category,
 * so withholding the Financials TAB while leaving those downloadable would be
 * a hole. Roles without the financials capability don't see that category.
 */
export function visibleDocumentCategories(
  role: ClientRole | null | undefined,
  isPlatformAdmin: boolean
): { all: boolean; hidden: string[] } {
  if (isPlatformAdmin || roleCan(role, "financials")) return { all: true, hidden: [] };
  return { all: false, hidden: ["Financials"] };
}
