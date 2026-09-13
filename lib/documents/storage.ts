import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const bucket = () => process.env.SUPABASE_DOCUMENTS_BUCKET || "documents";

export async function storePrivatePdf(path: string, bytes: Uint8Array) {
  const { error } = await getSupabaseAdmin().storage.from(bucket()).upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (error) throw new Error("Could not store the PDF privately.");
}

export async function removePrivatePdf(path: string) {
  const { error } = await getSupabaseAdmin().storage.from(bucket()).remove([path]);
  if (error) throw new Error("Could not remove the private PDF.");
}
