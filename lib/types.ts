// Shared types mirroring the database schema (see supabase/migrations).

export type Role = "admin" | "client";

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
};

export const DOCUMENT_CATEGORIES: DocumentCategory[] = [
  "Financials",
  "Tax",
  "Contracts",
  "Reports",
  "Other",
];
