"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DocumentRecord } from "@/types/documents";

export type ReadyDocMeta = { id: string; displayName: string; pageCount: number | null };

export interface DocumentWorkspaceHandle {
  triggerUpload: () => void;
}

interface DocumentWorkspaceProps {
  // When provided, ready documents become selectable as answer sources.
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  // Fires whenever the set of ready documents changes, so the workspace can
  // adapt its empty / grounded states without duplicating the fetch.
  onReadyDocsChange?: (docs: ReadyDocMeta[]) => void;
}

type Friendly = { label: string; detail: string; tone: "ready" | "processing" | "problem" };

function friendlyStatus(document: DocumentRecord): Friendly {
  switch (document.status) {
    case "ready":
      return {
        label: "Ready",
        detail: document.pageCount != null ? `${document.pageCount} page${document.pageCount === 1 ? "" : "s"}` : "",
        tone: "ready",
      };
    case "failed":
      return { label: "Processing failed", detail: document.failureReason || "This PDF could not be processed.", tone: "problem" };
    case "needs_ocr":
      return { label: "Scanned PDF", detail: "Text extraction unavailable", tone: "problem" };
    default:
      return { label: "Processing", detail: "Preparing document…", tone: "processing" };
  }
}

const toneDot: Record<Friendly["tone"], string> = {
  ready: "bg-accent",
  processing: "bg-muted",
  problem: "bg-[#e9a991]",
};
const toneText: Record<Friendly["tone"], string> = {
  ready: "text-accent-dim",
  processing: "text-muted",
  problem: "text-[#e9a991]",
};

const DocumentWorkspace = forwardRef<DocumentWorkspaceHandle, DocumentWorkspaceProps>(function DocumentWorkspace(
  { selectedIds, onSelectionChange, onReadyDocsChange },
  ref,
) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectable = onSelectionChange !== undefined;
  const selected = selectedIds ?? [];

  useImperativeHandle(ref, () => ({ triggerUpload: () => inputRef.current?.click() }), []);

  const loadDocuments = useCallback(async () => {
    try {
      const response = await fetch("/api/documents");
      if (!response.ok) throw new Error("Could not load your study material.");
      const data = (await response.json()) as { documents: DocumentRecord[] };
      setDocuments(data.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your study material.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadDocuments(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDocuments]);

  // Publish the ready-document set upward.
  useEffect(() => {
    if (!onReadyDocsChange) return;
    onReadyDocsChange(
      documents
        .filter((document) => document.status === "ready")
        .map((document) => ({ id: document.id, displayName: document.displayName, pageCount: document.pageCount })),
    );
  }, [documents, onReadyDocsChange]);

  // Keep the selection restricted to documents that still exist and are ready.
  useEffect(() => {
    if (!onSelectionChange) return;
    const readyIds = new Set(documents.filter((document) => document.status === "ready").map((document) => document.id));
    const pruned = (selectedIds ?? []).filter((id) => readyIds.has(id));
    if (pruned.length !== (selectedIds ?? []).length) onSelectionChange(pruned);
  }, [documents, selectedIds, onSelectionChange]);

  const toggle = (id: string) => {
    if (!onSelectionChange) return;
    onSelectionChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  };

  const uploadFile = async (file: File | undefined | null) => {
    if (!file || isUploading) return;
    setIsUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/documents", { method: "POST", body });
      const data = (await response.json()) as { document?: DocumentRecord; error?: string };
      if (!response.ok || !data.document) throw new Error(data.error || "That upload could not be completed.");
      setDocuments((current) => [data.document!, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That upload could not be completed.");
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (id: string) => {
    setError(null);
    setConfirmingId(null);
    try {
      const response = await fetch(`/api/documents/${id}`, { method: "DELETE" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "That document could not be removed.");
      setDocuments((current) => current.filter((document) => document.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That document could not be removed.");
    }
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    void uploadFile(event.dataTransfer.files?.[0]);
  };

  const selectedCount = selectable ? selected.length : 0;

  return (
    <section aria-label="Study material" className="flex flex-col gap-5">
      <div>
        <h2 className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Documents</h2>

        <div
          onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          className={`mt-3 rounded-lg border border-dashed px-4 py-6 text-center transition-colors duration-150 ${
            isDragging ? "border-accent/55 bg-accent/[0.05]" : "border-line-strong hover:border-[rgba(244,241,234,0.26)]"
          }`}
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-ink">Add study material</p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            {isUploading ? (
              "Processing…"
            ) : (
              <>
                Drop a PDF here, or{" "}
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  choose a file
                </button>
              </>
            )}
          </p>
          <p className="mt-2.5 text-[10px] uppercase tracking-[0.15em] text-muted/60">PDF · max 20 MB</p>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            aria-label="Upload a PDF of your study material"
            onChange={(event) => void uploadFile(event.target.files?.[0])}
          />
        </div>

        {error && (
          <p role="alert" className="mt-2 flex items-start gap-1.5 text-[12px] text-[#e9a991]">
            <span aria-hidden>—</span>
            <span>{error}</span>
          </p>
        )}
      </div>

      <div>
        {selectable && documents.length > 0 && (
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Sources</h3>
            <span className={`text-[10px] uppercase tracking-[0.16em] ${selectedCount > 0 ? "text-accent-dim" : "text-muted/60"}`}>
              {selectedCount > 0 ? `${selectedCount} selected` : "none selected"}
            </span>
          </div>
        )}

        {isLoading ? (
          <p className="mt-3 text-[12px] text-muted">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="mt-3 border-t border-line pt-3 text-[12px] leading-relaxed text-muted">
            No study material yet. Upload a PDF to get started.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {documents.map((document) => {
              const status = friendlyStatus(document);
              const isReady = document.status === "ready";
              const isSelected = selectable && selected.includes(document.id);
              const isConfirming = confirmingId === document.id;
              return (
                <li
                  key={document.id}
                  className={`group border-t border-line py-3 transition-colors duration-150 first:border-t-0 ${
                    isSelected
                      ? "bg-accent/[0.045]"
                      : isReady && selectable
                        ? "hover:bg-[rgba(244,241,234,0.022)]"
                        : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <label className={`flex min-w-0 flex-1 items-start gap-2.5 ${isReady && selectable ? "cursor-pointer" : ""}`}>
                      {selectable && (
                        <input
                          type="checkbox"
                          checked={!!isSelected}
                          disabled={!isReady}
                          onChange={() => toggle(document.id)}
                          className="mt-[3px] h-3.5 w-3.5 flex-shrink-0 accent-accent disabled:opacity-25 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          aria-label={`Use “${document.displayName}” as a source${isReady ? "" : " (available once processing finishes)"}`}
                        />
                      )}
                      <span className="min-w-0">
                        <span className={`block truncate text-[13px] ${isSelected ? "text-ink" : "text-ink/90"}`}>{document.displayName}</span>
                        <span className="mt-1 flex min-w-0 items-center gap-1.5">
                          <span aria-hidden className={`h-1 w-1 flex-shrink-0 rounded-full ${toneDot[status.tone]}`} />
                          <span className={`flex-shrink-0 whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.15em] ${toneText[status.tone]}`}>{status.label}</span>
                          {status.detail && (
                            <span className="min-w-0 truncate text-[11px] text-muted" title={status.detail}>
                              · {status.detail}
                            </span>
                          )}
                        </span>
                      </span>
                    </label>

                    <span className="flex flex-shrink-0 items-center gap-2.5 pt-[1px]">
                      {isConfirming ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void remove(document.id)}
                            className="text-[10px] font-medium uppercase tracking-[0.15em] text-[#e9a991] transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingId(null)}
                            className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(document.id)}
                          aria-label={`Remove “${document.displayName}”`}
                          className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted opacity-60 transition-[color,opacity] duration-150 hover:text-[#e9a991] hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent group-hover:opacity-100 group-focus-within:opacity-100"
                        >
                          Remove
                        </button>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
});

export default DocumentWorkspace;
