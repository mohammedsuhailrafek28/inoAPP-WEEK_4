import { NextRequest, NextResponse } from "next/server";
import { generateResponse } from "@/lib/ai";
import { ChatRequest, ExplanationMode, ExamMarks } from "@/types/chat";

const VALID_MODES: ExplanationMode[] = ["simple", "detailed", "exam"];
const VALID_MARKS: ExamMarks[] = [2, 5, 10, 16];

export async function POST(request: NextRequest) {
  try {
    // Check API key is configured
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json(
        { error: "AI service is not configured. Please contact the administrator." },
        { status: 503 }
      );
    }

    // Parse request body
    let body: ChatRequest;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid request format." },
        { status: 400 }
      );
    }

    // Validate message
    const { message, mode, history, marks } = body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json(
        { error: "Please enter a question before sending." },
        { status: 400 }
      );
    }

    if (message.trim().length > 10000) {
      return NextResponse.json(
        { error: "Your question is too long. Please keep it under 10,000 characters." },
        { status: 400 }
      );
    }

    // Validate mode
    if (!mode || !VALID_MODES.includes(mode)) {
      return NextResponse.json(
        { error: "Invalid explanation mode. Please select 'simple', 'detailed', or 'exam'." },
        { status: 400 }
      );
    }

    // Validate marks if provided
    let validatedMarks: ExamMarks | undefined;
    if (marks !== undefined) {
      if (typeof marks !== "number" || !VALID_MARKS.includes(marks as ExamMarks)) {
        return NextResponse.json(
          { error: "Invalid marks value. Please select 2, 5, 10, or 16 marks." },
          { status: 400 }
        );
      }
      validatedMarks = marks as ExamMarks;
    }

    // Validate history
    if (history && !Array.isArray(history)) {
      return NextResponse.json(
        { error: "Invalid conversation history format." },
        { status: 400 }
      );
    }

    // Generate response
    const content = await generateResponse(
      message.trim(),
      mode,
      history || [],
      validatedMarks
    );

    return NextResponse.json({ content });
  } catch (error: unknown) {
    console.error("Chat API Error:", error);

    // Handle specific error types
    if (error instanceof Error) {
      if (error.message.includes("GEMINI_API_KEY")) {
        return NextResponse.json(
          { error: "AI service is not configured. Please add your API key." },
          { status: 503 }
        );
      }

      if (
        error.message.includes("quota") ||
        error.message.includes("rate") ||
        error.message.includes("503") ||
        error.message.includes("high demand") ||
        error.message.includes("UNAVAILABLE") ||
        error.message.includes("RESOURCE_EXHAUSTED")
      ) {
        return NextResponse.json(
          { error: "The AI service is currently busy or experiencing high demand. Please wait a moment and try again." },
          { status: 503 }
        );
      }

      if (error.message.includes("empty response")) {
        return NextResponse.json(
          { error: "The AI couldn't generate a response. Please rephrase your question." },
          { status: 502 }
        );
      }
    }

    return NextResponse.json(
      { error: "Something went wrong while generating a response. Please try again." },
      { status: 500 }
    );
  }
}
