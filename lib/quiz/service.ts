// Quiz orchestration + persistence (ARCHITECTURE.md §18/§20, Phase 9). Module path matches
// the task's own suggested `lib/quiz/service.ts`.
//
// Two entry points, matching §28's locked routes exactly:
//   generateQuiz()      -> POST /api/quiz/generate
//   submitQuizAnswer()  -> POST /api/quiz/[id]/submit
//
// generateQuiz() pipeline (§18): selectNextActivity() [reused, never duplicated] -> eligibility
// check -> retrieve [reused Week 2 lib/documents/retrieval.ts] -> ONE Gemini call
// [lib/quiz/generate.ts] -> validate [lib/quiz/validate.ts] -> persist.
//
// submitQuizAnswer() pipeline (§20): CAS-style status guard (wins exclusive right to score) ->
// score [lib/quiz/evaluation.ts] -> ONE QUIZ_ANSWERED event + BKT + IRT + FSRS
// [lib/learning/reviews.ts::recordScoredOutcomeWithRetention(), reused, never duplicated] -> ONE
// TRANSFER_ATTEMPTED event + transfer evidence (always -- §12: every question has a transfer
// dimension) -> optional MISCONCEPTION_OBSERVED candidate (short-answer, incorrect only) ->
// persist quiz_answers -> recompute §17 fresh for the response payload (never persisted).
//
// Idempotency (§20, "simplified deliberately from the source"): the guarded
// `UPDATE quizzes SET status='submitted' WHERE status='in_progress'` is this function's ENTIRE
// concurrency mechanism -- a plain WHERE-guarded update on a text enum, not a CAS retry loop,
// because unlike BKT/IRT/FSRS there is no numeric accumulator a lost update could desynchronize:
// exactly one caller ever wins the transition, and only the winner ever scores/emits evidence. A
// second concurrent/retried request that loses the race short-circuits to the already-persisted
// quiz_answers row. No distributed-transaction/replay machinery wraps the steps after the guard
// (§20/§36: explicitly NOT SUITABLE for a single-process app) -- a DB error between winning the
// guard and finishing persistence is a known, accepted edge case, not silently pretended away.

import "server-only";
import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { selectNextActivity } from "@/lib/pedagogy/select";
import { getConcept } from "@/lib/learning/concepts";
import { difficultyBandToB } from "@/lib/learning/irt";
import { retrieveDocumentChunks, type RetrievalResult } from "@/lib/documents/retrieval";
import { assignEvidenceLabels } from "@/lib/documents/citations";
import { buildQuizPrompt, generateQuizQuestionRaw, parseGeneratedQuestion, QuizGenerationError, type QuizGenerationDependencies } from "@/lib/quiz/generate";
import { validateGeneratedQuestion } from "@/lib/quiz/validate";
import { scoreMcq, gradeShortAnswer, QuizScoringError, type EvaluationDependencies } from "@/lib/quiz/evaluation";
import { recordScoredOutcomeWithRetention } from "@/lib/learning/reviews";
import { recordLearningEvent } from "@/lib/learning/events";
import { applyTransferEvidence } from "@/lib/learning/transfer";
import { recordMisconceptionEvidence, reevaluateMisconceptionResolution, listMisconceptions } from "@/lib/learning/misconceptions";
import { getOrStartSessionForMeaningfulActivity } from "@/lib/learning/sessions";
import { QUIZ_ELIGIBLE_ACTIONS } from "@/types/learning";
import type { QuestionType, QuizEligibleAction, QuizGenerationRequest, QuizGenerationResult, QuizQuestionInternal, QuizQuestionRecord, QuizRecord, QuizSubmissionRequest, QuizSubmissionResult, TransferLevel } from "@/types/learning";

export class QuizValidationError extends Error {}

type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

const MATCH_COUNT_FOR_QUIZ = 5; // same default as chat RAG (lib/documents/retrieval.ts) -- no separate retrieval tuning invented for quizzes

export interface QuizServiceDependencies {
  supabase?: SupabaseClient;
  now?: Date;
  retrieve?: (question: string, documentIds: string[]) => Promise<RetrievalResult>;
  generate?: (prompt: ReturnType<typeof buildQuizPrompt>, deps?: QuizGenerationDependencies) => Promise<string>;
  evaluationDeps?: EvaluationDependencies;
}

function isEligibleAction(action: string): action is QuizEligibleAction {
  return (QUIZ_ELIGIBLE_ACTIONS as readonly string[]).includes(action);
}

function toQuizRecord(row: Record<string, unknown>): QuizRecord {
  return {
    id: row.id as string,
    studentId: row.student_id as string,
    sessionId: (row.session_id as string | null) ?? null,
    subject: row.subject as string,
    action: row.action as QuizEligibleAction,
    targetConceptId: row.target_concept_id as string,
    difficulty: row.difficulty as QuizRecord["difficulty"],
    status: row.status as QuizRecord["status"],
    score: (row.score as number | null) ?? null,
    createdAt: row.created_at as string,
    submittedAt: (row.submitted_at as string | null) ?? null,
  };
}

function toQuestionRecord(row: Record<string, unknown>): QuizQuestionRecord {
  return {
    id: row.id as string,
    quizId: row.quiz_id as string,
    conceptId: row.concept_id as string,
    questionType: row.question_type as QuestionType,
    questionText: row.question_text as string,
    options: (row.options as string[] | null) ?? null,
    irtDifficultyB: row.irt_difficulty_b as number,
    transferDimension: row.transfer_dimension as TransferLevel,
    citations: (row.citations as QuizQuestionRecord["citations"]) ?? [],
    createdAt: row.created_at as string,
  };
}

function toQuestionInternal(row: Record<string, unknown>): QuizQuestionInternal {
  return { ...toQuestionRecord(row), correctAnswer: row.correct_answer as string };
}

async function getPriorConceptChunkIds(studentId: string, conceptId: string, supabase: SupabaseClient): Promise<string[]> {
  const { data: quizRows, error: quizError } = await supabase.from("quizzes").select("id").eq("student_id", studentId).eq("target_concept_id", conceptId).order("created_at", { ascending: true }).limit(1);
  if (quizError) throw new Error("Could not load this concept's prior quiz history.");
  const priorQuizId = (quizRows ?? [])[0]?.id as string | undefined;
  if (!priorQuizId) return [];
  const { data: questionRows, error: questionError } = await supabase.from("quiz_questions").select("citations").eq("quiz_id", priorQuizId);
  if (questionError) throw new Error("Could not load this concept's prior question citations.");
  const chunkIds = new Set<string>();
  for (const row of (questionRows ?? []) as Record<string, unknown>[]) {
    for (const citation of (row.citations as { chunkId?: string }[] | null) ?? []) {
      if (citation.chunkId) chunkIds.add(citation.chunkId);
    }
  }
  return [...chunkIds];
}

/**
 * §18's generation pipeline. The client supplies only `subject` + `documentIds` (Step 4: never a
 * concept, difficulty, or pedagogical action) -- every authoritative choice comes from
 * selectNextActivity() (§17, reused verbatim).
 */
export async function generateQuiz(studentId: string, request: QuizGenerationRequest, dependencies: QuizServiceDependencies = {}): Promise<QuizGenerationResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  if (!request.subject || typeof request.subject !== "string" || !request.subject.trim()) throw new QuizValidationError("A subject is required.");
  if (!Array.isArray(request.documentIds) || request.documentIds.length === 0 || !request.documentIds.every((id) => typeof id === "string" && id.trim())) {
    throw new QuizValidationError("Select at least one ready document.");
  }

  const session = await getOrStartSessionForMeaningfulActivity(studentId, request.subject, { supabase });
  const activity = await selectNextActivity(studentId, request.subject, { supabase, now });

  if (!activity.decision) return { status: "generation_failed", reason: "No concepts are registered for this subject yet." };
  const { action, difficulty, targetConceptId, reasonCodes } = activity.decision;
  if (!isEligibleAction(action)) return { status: "not_eligible", action, rationale: reasonCodes };

  const concept = await getConcept(targetConceptId, { supabase });
  if (!concept) throw new QuizValidationError("Unknown target concept."); // INVALID_TARGET_CONCEPT guard -- selectNextActivity always resolves a real concept, so this is defense-in-depth, never expected to trigger

  const requestedQuestionType: QuestionType = action === "TRANSFER_CHALLENGE" ? "short_answer" : "mcq";

  const retrieve = dependencies.retrieve ?? ((question, documentIds) => retrieveDocumentChunks(question, documentIds, MATCH_COUNT_FOR_QUIZ, undefined, { supabase }));
  let retrieval: RetrievalResult;
  try {
    retrieval = await retrieve(concept.displayName, request.documentIds);
  } catch (error) {
    return { status: "generation_failed", reason: error instanceof Error ? error.message : "Retrieval failed." };
  }
  if (!retrieval || retrieval.status !== "sufficient" || retrieval.matches.length === 0) return { status: "insufficient_evidence" };

  const labeled = assignEvidenceLabels(retrieval.matches);
  const prompt = buildQuizPrompt({ conceptDisplayName: concept.displayName, questionType: requestedQuestionType, difficulty, labeledEvidence: labeled });

  let raw: string;
  try {
    raw = await (dependencies.generate ?? ((p) => generateQuizQuestionRaw(p)))(prompt);
  } catch (error) {
    return { status: "generation_failed", reason: error instanceof QuizGenerationError ? error.message : "Quiz generation failed." };
  }

  const candidate = parseGeneratedQuestion(raw);
  const priorConceptChunkIds = await getPriorConceptChunkIds(studentId, concept.id, supabase);
  const validation = validateGeneratedQuestion({ candidate, labeledEvidence: labeled, selectedDocumentIds: request.documentIds, action, priorConceptChunkIds });
  if (!validation.valid) return { status: "generation_failed", reason: `Generated question rejected: ${validation.reason}` };

  const generated = candidate as { questionType: QuestionType; questionText: string; options?: string[]; correctAnswer: string; explanation: string };
  const irtDifficultyB = difficultyBandToB(difficulty);

  const quizId = randomUUID();
  const { error: quizInsertError } = await supabase.from("quizzes").insert({
    id: quizId,
    student_id: studentId,
    session_id: session.id,
    subject: request.subject,
    action,
    target_concept_id: concept.id,
    difficulty,
    status: "in_progress",
  });
  if (quizInsertError) throw new Error("Could not create the quiz.");

  const questionId = randomUUID();
  const { data: questionRow, error: questionInsertError } = await supabase
    .from("quiz_questions")
    .insert({
      id: questionId,
      quiz_id: quizId,
      concept_id: concept.id,
      question_type: generated.questionType,
      question_text: generated.questionText,
      options: generated.questionType === "mcq" ? generated.options : null,
      correct_answer: generated.correctAnswer,
      explanation: generated.explanation,
      irt_difficulty_b: irtDifficultyB,
      transfer_dimension: validation.transferDimension,
      citations: validation.citations,
    })
    .select()
    .single();
  if (questionInsertError || !questionRow) throw new Error("Could not create the quiz question.");

  await recordLearningEvent({ studentId, sessionId: session.id, eventType: "QUIZ_STARTED", conceptId: concept.id, metadata: { action, difficulty } }, { supabase });

  const { data: quizRow, error: quizReadError } = await supabase.from("quizzes").select().eq("id", quizId).single();
  if (quizReadError || !quizRow) throw new Error("Could not load the created quiz.");

  return { status: "generated", quiz: toQuizRecord(quizRow), question: toQuestionRecord(questionRow), rationale: reasonCodes };
}

async function loadIdempotentResult(quizId: string, questionId: string, quiz: Record<string, unknown>, supabase: SupabaseClient, dependencies: QuizServiceDependencies): Promise<QuizSubmissionResult> {
  const { data: answerRow, error } = await supabase.from("quiz_answers").select().eq("quiz_id", quizId).eq("question_id", questionId).maybeSingle();
  if (error || !answerRow) throw new Error("This quiz has already been submitted, but its recorded answer could not be found.");
  const subject = quiz.subject as string;
  const studentId = quiz.student_id as string;
  const nextActivity = await selectNextActivity(studentId, subject, { supabase, now: dependencies.now });
  return {
    correct: answerRow.correct as boolean,
    score: answerRow.score as number,
    feedback: (answerRow.feedback as string | null) ?? null,
    quiz: toQuizRecord(quiz),
    alreadyProcessed: true,
    nextActivity,
  };
}

/**
 * §20's answer pipeline. `questionId` inside `request` is validated against `quizId` -- a client
 * can never submit against a question that doesn't belong to the quiz it claims.
 */
export async function submitQuizAnswer(studentId: string, quizId: string, request: QuizSubmissionRequest, dependencies: QuizServiceDependencies = {}): Promise<QuizSubmissionResult> {
  const supabase = dependencies.supabase ?? getSupabaseAdmin();
  const now = dependencies.now ?? new Date();

  if (!request.questionId || typeof request.questionId !== "string") throw new QuizValidationError("A questionId is required.");
  if (typeof request.submittedAnswer !== "string" || !request.submittedAnswer.trim()) throw new QuizValidationError("A submittedAnswer is required.");

  const { data: quizRow, error: quizError } = await supabase.from("quizzes").select().eq("id", quizId).maybeSingle();
  if (quizError) throw new Error("Could not load the quiz.");
  if (!quizRow || quizRow.student_id !== studentId) throw new QuizValidationError("Unknown quiz.");

  const { data: questionRow, error: questionError } = await supabase.from("quiz_questions").select().eq("id", request.questionId).eq("quiz_id", quizId).maybeSingle();
  if (questionError) throw new Error("Could not load the quiz question.");
  if (!questionRow) throw new QuizValidationError("This question does not belong to the specified quiz.");
  const question = toQuestionInternal(questionRow);

  if (quizRow.status === "submitted") return loadIdempotentResult(quizId, request.questionId, quizRow, supabase, dependencies);
  if (quizRow.status === "abandoned") throw new QuizValidationError("This quiz has been abandoned.");

  const submittedAnswer = request.submittedAnswer.trim();
  if (question.questionType === "mcq" && question.options && !question.options.includes(submittedAnswer)) {
    throw new QuizValidationError("submittedAnswer must be exactly one of the question's options.");
  }

  // The CAS-style guard (§20): only the request that flips in_progress -> submitted proceeds to
  // score/emit evidence. A losing concurrent/retried request falls back to the idempotent read.
  const { data: guardedRows, error: guardError } = await supabase
    .from("quizzes")
    .update({ status: "submitted", submitted_at: now.toISOString() })
    .eq("id", quizId)
    .eq("status", "in_progress")
    .select();
  if (guardError) throw new Error("Could not submit the quiz.");
  if (!guardedRows || guardedRows.length === 0) return loadIdempotentResult(quizId, request.questionId, quizRow, supabase, dependencies);

  let correct: boolean;
  let score: number;
  let feedback: string | null;
  let evidenceTrust: "deterministic" | "llm_graded";
  let proposedMisconceptionTag: string | null = null;
  let proposedMisconceptionDescription: string | null = null;

  if (question.questionType === "mcq") {
    const result = scoreMcq(submittedAnswer, question.correctAnswer);
    correct = result.correct;
    score = result.score;
    feedback = questionRow.explanation as string; // the question's own explanation, authored/validated at generation time (§19) -- cosmetic only, never authoritative for scoring
    evidenceTrust = "deterministic";
  } else {
    const concept = await getConcept(question.conceptId, { supabase });
    const graded = await gradeShortAnswer(
      { conceptDisplayName: concept?.displayName ?? "this concept", questionText: question.questionText, referenceAnswer: question.correctAnswer, submittedAnswer },
      dependencies.evaluationDeps,
    );
    correct = graded.correct;
    score = graded.score;
    feedback = graded.feedback;
    evidenceTrust = "llm_graded";
    proposedMisconceptionTag = graded.proposedMisconceptionTag;
    proposedMisconceptionDescription = graded.proposedMisconceptionDescription;
  }

  const outcome = await recordScoredOutcomeWithRetention(
    { studentId, sessionId: quizRow.session_id as string | null, conceptId: question.conceptId, outcome: correct ? "correct" : "incorrect", difficulty: quizRow.difficulty as QuizRecord["difficulty"], itemType: question.questionType },
    { supabase },
  );

  // §12: every question carries a transfer dimension; every scored answer feeds its counters --
  // not only TRANSFER_CHALLENGE questions (recall/application accrue from ordinary mcq/short_answer
  // quiz activity too, exactly as §12's "category assignment ... set at generation time" implies).
  const transferEvent = await recordLearningEvent({ studentId, sessionId: quizRow.session_id as string | null, eventType: "TRANSFER_ATTEMPTED", conceptId: question.conceptId, metadata: { dimension: question.transferDimension, score } }, { supabase });
  await applyTransferEvidence({ studentId, conceptId: question.conceptId, level: question.transferDimension, score, sourceEventId: transferEvent.id, evidenceTrust }, { supabase });

  if (proposedMisconceptionTag) {
    const misconceptionEvent = await recordLearningEvent(
      { studentId, sessionId: quizRow.session_id as string | null, eventType: "MISCONCEPTION_OBSERVED", conceptId: question.conceptId, metadata: { tag: proposedMisconceptionTag, proposedByLlm: true, relatedEventId: outcome.event.id } },
      { supabase },
    );
    await recordMisconceptionEvidence({ studentId, conceptId: question.conceptId, sourceEventId: misconceptionEvent.id, tag: proposedMisconceptionTag, description: proposedMisconceptionDescription ?? "Proposed by the short-answer grader." }, { supabase });
  }
  // §11's on-read resolution pass: recompute every currently-active misconception on this concept
  // now that a new interaction has occurred, regardless of whether this answer proposed a new one.
  const activeMisconceptions = await listMisconceptions(studentId, { conceptId: question.conceptId, status: "active" }, { supabase });
  for (const misconception of activeMisconceptions) {
    await reevaluateMisconceptionResolution(studentId, question.conceptId, misconception.tag, { supabase });
  }

  const { error: answerInsertError } = await supabase.from("quiz_answers").insert({
    id: randomUUID(),
    quiz_id: quizId,
    question_id: request.questionId,
    student_id: studentId,
    submitted_answer: submittedAnswer,
    correct,
    score,
    evidence_trust: evidenceTrust,
    feedback,
    response_time_ms: request.responseTimeMs ?? null,
    source_event_id: outcome.event.id,
  });
  if (answerInsertError) throw new Error("Could not record the quiz answer.");

  await supabase.from("quizzes").update({ score }).eq("id", quizId);
  await recordLearningEvent({ studentId, sessionId: quizRow.session_id as string | null, eventType: "QUIZ_COMPLETED", conceptId: question.conceptId, metadata: { score } }, { supabase });

  const { data: finalQuizRow, error: finalQuizError } = await supabase.from("quizzes").select().eq("id", quizId).single();
  if (finalQuizError || !finalQuizRow) throw new Error("Could not load the submitted quiz.");

  // A fresh timestamp, not the `now` captured at function entry: recordScoredOutcomeWithRetention()
  // and every event emitted above stamp `occurred_at` from the DB's own now() at write time (never
  // from this function's `now` parameter), which can land a few milliseconds AFTER it -- reusing
  // the stale entry-time `now` here could make FSRS's daysBetween(lastReviewedAt, now) go negative.
  const nextActivity = await selectNextActivity(studentId, finalQuizRow.subject as string, { supabase, now: new Date() });
  return { correct, score, feedback, quiz: toQuizRecord(finalQuizRow), alreadyProcessed: false, nextActivity };
}

export { QuizScoringError };
export const QUIZ_MATCH_COUNT = MATCH_COUNT_FOR_QUIZ;
