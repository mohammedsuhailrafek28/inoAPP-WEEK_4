import { NextRequest, NextResponse } from "next/server";
import { retrieveDocumentChunks } from "@/lib/documents/retrieval";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { question?: unknown; documentIds?: unknown };
    if (typeof body.question !== "string" || !Array.isArray(body.documentIds) || !body.documentIds.every((id) => typeof id === "string")) return NextResponse.json({ error: "A question and documentIds are required." }, { status: 400 });
    return NextResponse.json(await retrieveDocumentChunks(body.question, body.documentIds));
  } catch {
    // Never surface raw database / provider errors (matches app/api/rag/route.ts's pattern).
    return NextResponse.json({ error: "Retrieval failed. Please try again." }, { status: 500 });
  }
}
