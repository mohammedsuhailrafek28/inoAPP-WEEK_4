import { NextRequest, NextResponse } from "next/server";
import { ingestPdf, listDocuments } from "@/lib/documents/ingestion";
import { DocumentValidationError, validatePdfUpload } from "@/lib/documents/validation";

export const runtime = "nodejs";

export async function GET() {
  try { return NextResponse.json({ documents: await listDocuments() }); }
  catch { return NextResponse.json({ error: "Could not load documents." }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a PDF file to upload." }, { status: 400 });
    const document = await ingestPdf(await validatePdfUpload(file));
    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    const message = error instanceof DocumentValidationError ? error.message : "Document upload could not be completed.";
    return NextResponse.json({ error: message }, { status: error instanceof DocumentValidationError ? 400 : 500 });
  }
}
