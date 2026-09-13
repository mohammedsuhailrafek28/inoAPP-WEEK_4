import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The generated Supabase database types are introduced alongside the applied migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adminClient: SupabaseClient<any> | undefined;

export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error("Document storage is not configured.");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminClient ??= createClient<any>(url, secretKey, { auth: { persistSession: false } });
  return adminClient;
}
