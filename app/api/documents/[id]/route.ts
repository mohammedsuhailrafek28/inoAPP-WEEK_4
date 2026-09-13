import { NextResponse } from "next/server";
import { deleteDocument } from "@/lib/documents/ingestion";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Document ID is required." }, { status: 400 });
    if (!(await deleteDocument(id))) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch { return NextResponse.json({ error: "Document deletion could not be completed." }, { status: 500 }); }
}
