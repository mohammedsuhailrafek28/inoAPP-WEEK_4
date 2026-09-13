import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  EXPLANATION_STYLES,
  PREFERRED_DIFFICULTIES,
  PREFERRED_PACES,
  type ProfileUpdateInput,
  type StudentProfile,
} from "@/types/learning";

export class ProfileValidationError extends Error {}

const DISPLAY_NAME_MAX = 80;
const ACADEMIC_LEVEL_MAX = 60;
const SUBJECT_MAX_LENGTH = 40;
const SUBJECTS_MAX_COUNT = 10;
const LONG_TEXT_MAX = 500; // learningGoals / examplePreference — echoed into prompts later, kept small

// Bootstrap defaults: a profile row must exist the moment ANY learner-scoped feature (a session, an
// event) needs a stable student_id, long before the student has necessarily opened the profile
// screen. These are clearly-a-placeholder values, never presented as if the student chose them --
// the frontend profile panel is expected to prompt for real values on first run.
const BOOTSTRAP_DISPLAY_NAME = "Student";
const BOOTSTRAP_ACADEMIC_LEVEL = "Not specified";

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

function toRow(row: Record<string, unknown>): StudentProfile {
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    academicLevel: row.academic_level as string,
    subjects: Array.isArray(row.subjects) ? (row.subjects as string[]) : [],
    learningGoals: (row.learning_goals as string | null) ?? null,
    preferredExplanationStyle: row.preferred_explanation_style as StudentProfile["preferredExplanationStyle"],
    preferredDifficulty: row.preferred_difficulty as StudentProfile["preferredDifficulty"],
    preferredPace: row.preferred_pace as StudentProfile["preferredPace"],
    examplePreference: (row.example_preference as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function boundedText(value: unknown, field: string, max: number, options: { required?: boolean } = {}): string | null | undefined {
  if (value === undefined) return undefined; // not supplied — leave the stored value untouched
  if (value === null) {
    if (options.required) throw new ProfileValidationError(`${field} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new ProfileValidationError(`${field} must be text.`);
  const trimmed = value.trim();
  if (options.required && !trimmed) throw new ProfileValidationError(`${field} is required.`);
  if (trimmed.length > max) throw new ProfileValidationError(`${field} must be ${max} characters or fewer.`);
  return trimmed || null;
}

function enumField<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ProfileValidationError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function normaliseSubjects(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ProfileValidationError("Subjects must be a list of short text tags.");
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") throw new ProfileValidationError("Each subject must be text.");
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > SUBJECT_MAX_LENGTH) throw new ProfileValidationError(`Each subject must be ${SUBJECT_MAX_LENGTH} characters or fewer.`);
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(trimmed);
  }
  if (cleaned.length > SUBJECTS_MAX_COUNT) throw new ProfileValidationError(`Choose at most ${SUBJECTS_MAX_COUNT} subjects.`);
  return cleaned;
}

/**
 * Validates a partial profile-update payload. Never throws for an omitted field (undefined means
 * "leave unchanged"); throws ProfileValidationError for a present-but-invalid field. Returns only
 * the DB column values that should actually be written.
 */
export function validateProfileUpdate(input: ProfileUpdateInput): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProfileValidationError("Invalid profile payload.");
  }
  const patch: Record<string, unknown> = {};

  const displayName = boundedText(input.displayName, "Display name", DISPLAY_NAME_MAX, { required: true });
  if (displayName !== undefined) patch.display_name = displayName;

  const academicLevel = boundedText(input.academicLevel, "Academic level", ACADEMIC_LEVEL_MAX, { required: true });
  if (academicLevel !== undefined) patch.academic_level = academicLevel;

  const subjects = normaliseSubjects(input.subjects);
  if (subjects !== undefined) patch.subjects = subjects;

  const learningGoals = boundedText(input.learningGoals, "Learning goals", LONG_TEXT_MAX);
  if (learningGoals !== undefined) patch.learning_goals = learningGoals;

  const style = enumField(input.preferredExplanationStyle, "Preferred explanation style", EXPLANATION_STYLES);
  if (style !== undefined) patch.preferred_explanation_style = style;

  const difficulty = enumField(input.preferredDifficulty, "Preferred difficulty", PREFERRED_DIFFICULTIES);
  if (difficulty !== undefined) patch.preferred_difficulty = difficulty;

  const pace = enumField(input.preferredPace, "Preferred pace", PREFERRED_PACES);
  if (pace !== undefined) patch.preferred_pace = pace;

  const examplePreference = boundedText(input.examplePreference, "Example preference", LONG_TEXT_MAX);
  if (examplePreference !== undefined) patch.example_preference = examplePreference;

  return patch;
}

export interface ProfileDependencies {
  supabase?: SupabaseClient;
}

/** Reads the single stored profile, or null if the student has never triggered creation of one. */
export async function getProfile(dependencies: ProfileDependencies = {}): Promise<StudentProfile | null> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const { data, error } = await supabase.from("student_profiles").select().limit(1).maybeSingle();
  if (error) throw new Error("Could not load the student profile.");
  return data ? toRow(data) : null;
}

/**
 * Single-user Auth Decision (ARCHITECTURE.md, unchanged from Revision 1): there is exactly
 * one student_profiles row. This is the one function every learner-scoped feature (sessions,
 * events, and everything later) calls to resolve "the current student" -- auto-creating a
 * bootstrap row with clearly-placeholder values on first touch so a stable student_id exists
 * before the student has necessarily filled out their profile. Real auth later replaces only the
 * body of this function (e.g. resolve auth.uid() instead), never the student_id-shaped schema
 * every other table already depends on.
 */
export async function getOrCreateDefaultProfile(dependencies: ProfileDependencies = {}): Promise<StudentProfile> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const existing = await getProfile({ supabase });
  if (existing) return existing;

  const { data, error } = await supabase
    .from("student_profiles")
    .insert({ id: randomUUID(), display_name: BOOTSTRAP_DISPLAY_NAME, academic_level: BOOTSTRAP_ACADEMIC_LEVEL })
    .select()
    .single();
  if (error || !data) throw new Error("Could not create the student profile.");
  return toRow(data);
}

/** Validated partial update. Creates the bootstrap row first if none exists yet, then applies the patch. */
export async function updateProfile(input: ProfileUpdateInput, dependencies: ProfileDependencies = {}): Promise<StudentProfile> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const patch = validateProfileUpdate(input);
  const current = await getOrCreateDefaultProfile({ supabase });
  if (Object.keys(patch).length === 0) return current;

  const { data, error } = await supabase.from("student_profiles").update(patch).eq("id", current.id).select().single();
  if (error || !data) throw new Error("Could not update the student profile.");
  return toRow(data);
}
