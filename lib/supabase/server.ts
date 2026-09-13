import "server-only";
import { createClient } from "@supabase/supabase-js";

export function getSupabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("Document storage is not configured.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createClient<any>(url, publishableKey, { auth: { persistSession: false } });
}
