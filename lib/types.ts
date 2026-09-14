// Shared types mirroring the database schema (see supabase/migrations).

// Platform role. "admin" = full GBTN staff (Tyler); "employee" = GBTN staff who
// work the CRM but can't provision clients, manage users, or see client
// financials; "client" = a customer of GBTN. "Staff" means admin ∪ employee.
export type Role = "admin" | "employee" | "client";

export type Profile = {
  id: string;
  full_name: string | null;
  role: Role;
  created_at: string;
};

export type Client = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};

export type Membership = {
  user_id: string;
  client_id: string;
  role: string;
  created_at: string;
};

export type DocumentCategory =
  | "Financials"
  | "Tax"
  | "Contracts"
  | "Reports"
  | "Other";

// Every column is required with the nullability the database actually has
// (0029 contract lifecycle + 0031 e-sign), so the row satisfies the e-sign
// helpers' parameter types under strict tsc. The e-sign columns are written
// only by the service role; see supabase/migrations/0031_esign_engine.sql.
export type ClientDocument = {
  id: string;
  client_id: string;
  uploaded_by: string | null;
  storage_path: string;
  file_name: string;
  byte_size: number;
  content_type: string | null;
  category: DocumentCategory;
  created_at: string;
  engagement_id: string | null;
  title: string | null;
  doc_type: string | null;
  version: number;
  /** draft | sent | executed | superseded (default 'executed'). */
  status: string;
  effective_date: string | null;
  visible_to_client: boolean;
  signature_request_id: string | null;
  signed_at: string | null;
  sealed_storage_path: string | null;
  /** Expiry of the request in signature_request_id while it is out for signature. */
  signature_expires_at: string | null;
};

export const DOCUMENT_CATEGORIES: DocumentCategory[] = [
  "Financials",
  "Tax",
  "Contracts",
  "Reports",
  "Other",
];
