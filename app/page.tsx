"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { ChatMessage, ExplanationMode, ExamMarks, ChatErrorResponse, MessageCitation } from "@/types/chat";
import Header from "@/components/Header";
import ModeControls from "@/components/ModeControls";
import ChatWindow from "@/components/ChatWindow";
import Composer from "@/components/Composer";
import EmptyState from "@/components/EmptyState";
import DocumentWorkspace, { type DocumentWorkspaceHandle, type ReadyDocMeta } from "@/components/DocumentWorkspace";
import Drawer from "@/components/Drawer";
import ProgressPanel from "@/components/ProgressPanel";
import PracticePanel from "@/components/PracticePanel";
import ProfilePanel from "@/components/ProfilePanel";
import PlanPanel from "@/components/PlanPanel";
import ConceptPicker from "@/components/ConceptPicker";
import type { ConceptSummary, ProgressOverview } from "@/types/progress";

const MODE_STORAGE_KEY = "ai-study-assistant-mode";
const MARKS_STORAGE_KEY = "ai-study-assistant-marks";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function loadMode(): ExplanationMode {
  if (typeof window === "undefined") return "simple";
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === "simple" || saved === "detailed" || saved === "exam") return saved;
  } catch {
    /* ignore */
  }
  return "simple";
}

function loadMarks(): ExamMarks {
  if (typeof window === "undefined") return 10;
  try {
    const saved = localStorage.getItem(MARKS_STORAGE_KEY);
    if (saved) {
      const num = Number(saved);
      if (num === 2 || num === 5 || num === 10 || num === 16) return num as ExamMarks;
    }
  } catch {
    /* ignore */
  }
  return 10;
}

type AssistantReply = { content: string; citations?: MessageCitation[]; groundingStatus?: "grounded" | "insufficient"; personalization?: ChatMessage["personalization"] };

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mode, setMode] = useState<ExplanationMode>("simple");
  const [marks, setMarks] = useState<ExamMarks>(10);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [readyDocs, setReadyDocs] = useState<ReadyDocMeta[]>([]);
  // Becomes true only after localStorage has been read back into state.
  // Persistence effects below are gated on this so the first commit (and
  // React StrictMode's double-invoked mount effect in dev) can never write
  // default values over the saved preferences before they are restored.
  const [isHydrated, setIsHydrated] = useState(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const libraryRef = useRef<DocumentWorkspaceHandle>(null);

  // Phase 12: personalization/progress/practice/profile UI state. None of this holds or computes
  // any learner-state value itself -- every field here is either UI-only (which panel is open) or
  // a direct pass-through of what the server already returned.
  const [activePanel, setActivePanel] = useState<"progress" | "practice" | "profile" | "plan" | null>(null);
  const [practiceSubject, setPracticeSubject] = useState<string | null>(null);
  const [conceptKey, setConceptKey] = useState<string | null>(null);
  const [reviewDueCount, setReviewDueCount] = useState(0);
  // Step 7: a concept-key -> display-name lookup for the personalization line on a grounded
  // reply. Presentation only -- ConceptPicker/PracticePanel already each fetch this same
  // already-existing endpoint independently for their own concept lists; this is a third,
  // equally read-only call, never a new API route.
  const [conceptNames, setConceptNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/learning/concepts");
        const data = (await response.json()) as { concepts?: ConceptSummary[] };
        if (!cancelled && Array.isArray(data.concepts)) {
          setConceptNames(Object.fromEntries(data.concepts.map((c) => [c.conceptKey, c.displayName])));
        }
      } catch {
        /* the personalization line simply omits the concept name if this fails */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshReviewDueCount = useCallback(async () => {
    try {
      const response = await fetch("/api/learning/progress");
      const data = (await response.json()) as ProgressOverview;
      if (Array.isArray(data.subjects)) {
        setReviewDueCount(data.subjects.reduce((sum, s) => sum + s.reviewDueCount, 0));
      }
    } catch {
      /* the review-due badge is a nicety; the Progress panel itself will show a real error if it can't load */
    }
  }, []);

  // A single load on mount, and a refresh whenever a panel that could have changed learner state
  // closes -- never polled (Step 36's "avoid unnecessary polling").
  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshReviewDueCount(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshReviewDueCount]);

  const closePanel = useCallback(() => {
    setActivePanel(null);
    void refreshReviewDueCount();
  }, [refreshReviewDueCount]);

  // Restore preferences after hydration. Chat messages are intentionally NOT
  // persisted — every reload starts with an empty in-memory conversation.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(loadMode());
    setMarks(loadMarks());
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(MARKS_STORAGE_KEY, String(marks));
  }, [marks, isHydrated]);

  const showError = useCallback((msg: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setError(msg);
    errorTimerRef.current = setTimeout(() => setError(null), 5000);
  }, []);

  const selectedNames = readyDocs.filter((doc) => selectedDocIds.includes(doc.id)).map((doc) => doc.displayName);
  const grounded = selectedDocIds.length > 0;

  // Single place that talks to the backend. Grounded RAG when ready documents
  // are selected; otherwise the generic Week 1 Study Assistant, unchanged.
  const fetchAssistantReply = useCallback(
    async (question: string, history: ChatMessage[]): Promise<AssistantReply> => {
      if (selectedDocIds.length > 0) {
        const response = await fetch("/api/rag", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            documentIds: selectedDocIds,
            mode,
            marks: mode === "exam" ? marks : undefined,
            history,
            // Step 5/§21: an OPTIONAL, explicit focus concept -- never authoritative for anything
            // beyond "which concept to personalize around." Omitted entirely means no personalization.
            conceptKey: conceptKey ?? undefined,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error((data as ChatErrorResponse).error || "Failed to get a response.");
        const citations = Array.isArray(data.citations)
          ? (data.citations as Array<{ citationId: string; filename: string; pageNumber: number }>).map((c) => ({
              citationId: c.citationId,
              filename: c.filename,
              pageNumber: c.pageNumber,
            }))
          : [];
        return { content: data.answer as string, citations, groundingStatus: data.status, personalization: data.personalization };
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          mode,
          history,
          marks: mode === "exam" ? marks : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error((data as ChatErrorResponse).error || "Failed to get a response.");
      return { content: data.content as string };
    },
    [selectedDocIds, mode, marks, conceptKey]
  );

  const runTurn = useCallback(
    async (question: string) => {
      const userMessage: ChatMessage = { id: generateId(), role: "user", content: question, timestamp: Date.now() };
      const history = messages;
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);
      setError(null);

      try {
        const reply = await fetchAssistantReply(question, history);
        const assistantMessage: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: reply.content,
          timestamp: Date.now(),
          ...(reply.citations && reply.citations.length > 0 ? { citations: reply.citations } : {}),
          ...(reply.groundingStatus ? { groundingStatus: reply.groundingStatus } : {}),
          ...(reply.personalization ? { personalization: reply.personalization } : {}),
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err: unknown) {
        let errorMessage = "Something went wrong. Please try again.";
        if (err instanceof TypeError && err.message.includes("fetch")) {
          errorMessage = "Network error — please check your internet connection and try again.";
        } else if (err instanceof Error) {
          errorMessage = err.message;
        }
        showError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    },
    [messages, fetchAssistantReply, showError]
  );

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    setInput("");
    void runTurn(trimmed);
  }, [input, isLoading, runTurn]);

  const handleClear = useCallback(() => {
    setMessages([]);
    setInput("");
    setError(null);
  }, []);

  const isEmpty = messages.length === 0 && !isLoading;

  return (
    <div className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:overflow-hidden">
      <Header
        onNewChat={handleClear}
        canReset={messages.length > 0}
        disabled={isLoading}
        activePanel={activePanel}
        onGoToLearn={closePanel}
        onOpenProgress={() => setActivePanel("progress")}
        onOpenPractice={() => setActivePanel("practice")}
        onOpenProfile={() => setActivePanel("profile")}
        onOpenPlan={() => setActivePanel("plan")}
        reviewDueCount={reviewDueCount}
      />

      <div className="mx-auto flex w-full max-w-[1140px] flex-1 flex-col lg:min-h-0 lg:flex-row">
        <aside className="max-h-[42vh] flex-shrink-0 overflow-y-auto border-b border-line px-6 py-6 scrollbar-thin lg:max-h-none lg:w-[300px] lg:border-b-0 lg:border-r">
          <DocumentWorkspace
            ref={libraryRef}
            selectedIds={selectedDocIds}
            onSelectionChange={setSelectedDocIds}
            onReadyDocsChange={setReadyDocs}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col lg:min-h-0">
          {isEmpty ? (
            <div className="flex-1 overflow-y-auto scrollbar-thin lg:min-h-0">
              <EmptyState
                input={input}
                onInputChange={setInput}
                onSend={handleSend}
                mode={mode}
                onModeChange={setMode}
                marks={marks}
                onMarksChange={setMarks}
                onUploadClick={() => libraryRef.current?.triggerUpload()}
                hasReadyDocs={readyDocs.length > 0}
                selectedCount={selectedDocIds.length}
                selectedName={selectedNames[0]}
                disabled={isLoading}
                onOpenPlan={() => setActivePanel("plan")}
                onOpenPractice={() => setActivePanel("practice")}
              />
            </div>
          ) : (
            <>
              <div className="flex-shrink-0 border-b border-line px-6 py-3.5">
                <div className="mx-auto flex max-w-[960px] flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <ModeControls
                    mode={mode}
                    onModeChange={setMode}
                    marks={marks}
                    onMarksChange={setMarks}
                    disabled={isLoading}
                    align="start"
                  />
                  <span className="flex flex-shrink-0 items-center gap-4">
                    <ConceptPicker value={conceptKey} onChange={setConceptKey} disabled={isLoading} />
                    <span
                      className={`hidden text-[10px] font-medium uppercase tracking-[0.18em] sm:inline ${
                        grounded ? "text-accent-dim" : "text-muted/50"
                      }`}
                    >
                      {grounded
                        ? `Answering from ${selectedDocIds.length} source${selectedDocIds.length === 1 ? "" : "s"}`
                        : "General mode"}
                    </span>
                  </span>
                </div>
              </div>

              <ChatWindow messages={messages} isLoading={isLoading} mode={mode} marks={marks} conceptNames={conceptNames} />

              <div className="sticky bottom-0 flex-shrink-0 border-t border-line bg-canvas px-6 py-4 lg:static">
                <div className="mx-auto max-w-[680px]">
                  <Composer
                    value={input}
                    onChange={setInput}
                    onSend={handleSend}
                    mode={mode}
                    marks={marks}
                    disabled={isLoading}
                    variant="sticky"
                    placeholder={grounded ? "Ask about your selected material…" : "Ask anything…"}
                  />
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {error && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-6">
          <div
            className="pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-lg border border-line-strong bg-elevated-2 px-4 py-2.5 text-[13px] text-ink"
            style={{ animation: "rise 0.28s ease-out" }}
          >
            <span aria-hidden className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="rounded-sm text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label="Dismiss error"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <Drawer open={activePanel === "progress"} onClose={closePanel} title="Progress">
        <ProgressPanel
          onPracticeSubject={(subject) => {
            setPracticeSubject(subject);
            setActivePanel("practice");
          }}
          documentIds={selectedDocIds}
        />
      </Drawer>
      <Drawer open={activePanel === "practice"} onClose={closePanel} title="Practice">
        <PracticePanel initialSubject={practiceSubject} documentIds={selectedDocIds} />
      </Drawer>
      <Drawer open={activePanel === "profile"} onClose={closePanel} title="Profile">
        <ProfilePanel />
      </Drawer>
      <Drawer open={activePanel === "plan"} onClose={closePanel} title="Plan">
        <PlanPanel
          onPracticeSubject={(subject) => {
            setPracticeSubject(subject);
            setActivePanel("practice");
          }}
          documentIds={selectedDocIds}
        />
      </Drawer>
    </div>
  );
}
