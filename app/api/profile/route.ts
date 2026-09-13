import { NextRequest, NextResponse } from "next/server";
import { ProfileValidationError, getProfile, updateProfile } from "@/lib/learning/profile";
import type { ProfileUpdateInput } from "@/types/learning";

export const runtime = "nodejs";

export async function GET() {
  try {
    const profile = await getProfile();
    if (!profile) return NextResponse.json({ profile: null });
    return NextResponse.json({ profile });
  } catch {
    return NextResponse.json({ error: "Could not load the student profile." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request format." }, { status: 400 });
  }

  // Never trust arbitrary client JSON beyond the documented fields -- an absent key naturally
  // reads as `undefined` here, which validateProfileUpdate() treats as "leave unchanged"; a
  // malformed present value is rejected there, not coerced or ignored.
  const input: ProfileUpdateInput = {
    displayName: body.displayName as ProfileUpdateInput["displayName"],
    academicLevel: body.academicLevel as ProfileUpdateInput["academicLevel"],
    subjects: body.subjects as ProfileUpdateInput["subjects"],
    learningGoals: body.learningGoals as ProfileUpdateInput["learningGoals"],
    preferredExplanationStyle: body.preferredExplanationStyle as ProfileUpdateInput["preferredExplanationStyle"],
    preferredDifficulty: body.preferredDifficulty as ProfileUpdateInput["preferredDifficulty"],
    preferredPace: body.preferredPace as ProfileUpdateInput["preferredPace"],
    examplePreference: body.examplePreference as ProfileUpdateInput["examplePreference"],
  };

  try {
    const profile = await updateProfile(input);
    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof ProfileValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not update the student profile." }, { status: 500 });
  }
}
