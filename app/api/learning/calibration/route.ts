import { NextResponse } from "next/server";
import { getOrCreateDefaultProfile } from "@/lib/learning/profile";
import { getCalibrationSignal } from "@/lib/learning/calibration";

export const runtime = "nodejs";

// Read-only (Step 24/35). Only the derived signal is exposed here -- raw calibration_records rows
// never surface in this API, matching §22's "only the derived bias scalar, if actionable, ever
// surfaces" rule (that rule is about the RAG prompt specifically; this route is stricter still,
// exposing only the fully-derived state/bias, never a raw predicted/actual pair).
export async function GET() {
  try {
    const profile = await getOrCreateDefaultProfile();
    const signal = await getCalibrationSignal(profile.id);
    return NextResponse.json(signal);
  } catch {
    return NextResponse.json({ error: "Could not load calibration signal." }, { status: 500 });
  }
}
