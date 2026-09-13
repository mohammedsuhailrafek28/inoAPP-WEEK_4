"use client";

import React from "react";
import { ChatMessage, ExplanationMode, ExamMarks } from "@/types/chat";
import { ACTION_LABEL, PEDAGOGICAL_REASON_LABEL, SCAFFOLDING_LABEL } from "@/lib/ui/labels";
import type { PedagogicalAction, PedagogicalReasonCode, ScaffoldingLevel } from "@/types/progress";

interface MessageBubbleProps {
  message: ChatMessage;
  mode?: ExplanationMode;
  marks?: ExamMarks;
  conceptNames?: Record<string, string>;
}

const MODE_META: Record<ExplanationMode, string> = {
  simple: "Simple",
  detailed: "Deep Dive",
  exam: "Exam",
};

/* ---------------------------------------------------------------
   Lightweight markdown -> HTML renderer.
   Supports: fenced code, GitHub tables, #/##/### headings,
   ordered/unordered lists, blockquotes, hr, bold/italic/inline code.
   Rendered inside .markdown-content (see globals.css).
   --------------------------------------------------------------- */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(text: string): string {
  let t = text;
  // inline code first so ** / * inside it are untouched
  t = t.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return t;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

// Exported for deterministic unit testing of the fenced-code placeholder handling.
export function renderMarkdown(raw: string): string {
  const escaped = escapeHtml(raw);

  // Protect fenced code blocks. The placeholder uses literal < > which cannot
  // appear in `escaped` (escapeHtml has already turned any user < > into &lt; &gt;),
  // so a fenced block can never be spoofed by document/message text — and the
  // token is plain text, keeping this file NUL-free UTF-8.
  const codeBlocks: string[] = [];
  const withPlaceholders = escaped.replace(
    /```[a-zA-Z0-9]*\n?([\s\S]*?)```/g,
    (_m, code: string) => {
      const idx = codeBlocks.length;
      codeBlocks.push(
        `<pre class="code-block"><code>${code.replace(/\n$/, "")}</code></pre>`
      );
      return `<<<CODE_BLOCK_${idx}>>>`;
    }
  );

  const lines = withPlaceholders.split("\n");
  const out: string[] = [];

  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join("<br />"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      const cls = listType === "ol" ? "msg-list numbered" : "msg-list";
      const liCls = listType === "ol" ? "msg-li numbered" : "msg-li bulleted";
      out.push(
        `<ul class="${cls}">${listItems
          .map((i) => `<li class="${liCls}">${inline(i)}</li>`)
          .join("")}</ul>`
      );
      listItems = [];
      listType = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inline(quote.join("<br />"))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushAll();
      continue;
    }

    // Code block placeholder on its own line
    const cbMatch = trimmed.match(/^<<<CODE_BLOCK_(\d+)>>>$/);
    if (cbMatch) {
      flushAll();
      out.push(codeBlocks[Number(cbMatch[1])]);
      continue;
    }

    // Headings
    const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushAll();
      const level = h[1].length;
      out.push(`<h${level} class="msg-h${level}">${inline(h[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ""))) {
      flushAll();
      out.push("<hr />");
      continue;
    }

    // Table: header row followed by separator row
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      const header = splitRow(trimmed);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      i--; // step back; for-loop will increment
      const thead = `<thead><tr>${header
        .map((c) => `<th>${inline(c)}</th>`)
        .join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map(
          (r) =>
            `<tr>${r
              .map((c) => `<td>${inline(c)}</td>`)
              .join("")}</tr>`
        )
        .join("")}</tbody>`;
      out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // Blockquote
    const bq = trimmed.match(/^>\s?(.*)$/);
    if (bq) {
      flushParagraph();
      flushList();
      quote.push(bq[1]);
      continue;
    }

    // Ordered list
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushParagraph();
      flushQuote();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(ol[1]);
      continue;
    }

    // Unordered list
    const ul = trimmed.match(/^[-*•]\s+(.*)$/);
    if (ul) {
      flushParagraph();
      flushQuote();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ul[1]);
      continue;
    }

    // Paragraph text
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushAll();
  return out.join("\n");
}

export default function MessageBubble({ message, mode, marks, conceptNames }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="border-l border-line-strong pl-4" style={{ animation: "fade-in 0.3s ease-out" }}>
        <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted/60">
          You
        </p>
        <p className="mt-2.5 whitespace-pre-wrap text-[15px] leading-[1.65] text-ink/90">
          {message.content}
        </p>
      </div>
    );
  }

  const activeMode: ExplanationMode = mode ?? "simple";
  const modeLabel =
    activeMode === "exam"
      ? `${MODE_META.exam} · ${marks ?? 10} Marks`
      : MODE_META[activeMode];
  const contextLabel =
    message.groundingStatus === "grounded"
      ? "Document grounded"
      : message.groundingStatus === "insufficient"
        ? "Document mode"
        : "General";

  let html = renderMarkdown(message.content);
  if (activeMode === "exam") {
    html = html.replace(
      /<h2 class="msg-h2">((?:\d+\.\s*)?conclusion[^<]*)<\/h2>/i,
      '<h2 class="msg-h2 msg-conclusion">$1</h2>'
    );
  }

  const citations = message.citations ?? [];
  const notFound = message.groundingStatus === "insufficient";

  return (
    <div style={{ animation: "fade-in 0.45s ease-out" }}>
      <div className="mb-5 flex items-center gap-2.5">
        <span aria-hidden className="h-px w-3.5 flex-shrink-0 bg-accent" />
        <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted/70">
          <span className="text-ink/80">Study AI</span>
          <span className="text-muted/50"> · {contextLabel} · {modeLabel}</span>
        </p>
      </div>

      {notFound && (
        <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.18em] text-ink/80">
          Not found in selected material
        </p>
      )}

      {message.personalization?.personalizationApplied && (
        <div className="mb-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted/50">
            {message.personalization.targetConceptKey && conceptNames?.[message.personalization.targetConceptKey] && (
              <span className="text-muted/70">{conceptNames[message.personalization.targetConceptKey]} · </span>
            )}
            {message.personalization.pedagogicalAction && `${ACTION_LABEL[message.personalization.pedagogicalAction as PedagogicalAction] ?? message.personalization.pedagogicalAction} · `}
            {message.personalization.scaffoldingLevel && SCAFFOLDING_LABEL[message.personalization.scaffoldingLevel as ScaffoldingLevel]}
          </p>
          {message.personalization.reasonCodes && message.personalization.reasonCodes.length > 0 && (
            <details className="mt-1.5 text-[11px] text-muted/60">
              <summary className="inline cursor-pointer select-none underline decoration-line-strong underline-offset-4 hover:decoration-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
                Why this approach?
              </summary>
              <p className="mt-1.5 leading-relaxed text-muted/70">
                {PEDAGOGICAL_REASON_LABEL[message.personalization.reasonCodes[0] as PedagogicalReasonCode] ?? "Adapted to your current progress on this concept."}
              </p>
            </details>
          )}
        </div>
      )}

      <div
        className="markdown-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {citations.length > 0 && (
        <div className="mt-7 border-t border-line pt-4">
          <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-muted/60">Sources</p>
          <ul className="mt-3 flex flex-col gap-3">
            {citations.map((citation, index) => (
              <li key={citation.citationId} className="flex gap-3">
                <span aria-hidden className="font-mono text-[11px] leading-[1.4] tabular-nums text-accent-dim">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12px] leading-[1.4] text-ink/80">{citation.filename}</span>
                  <span className="mt-0.5 block text-[11px] text-muted/70">Page {citation.pageNumber}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Loading indicator shown while the AI is generating a response.
    Anchored with the same accent hairline as the assistant reply so the
    pending answer appears exactly where the answer will render. */
export function TypingIndicator() {
  return (
    <div className="flex items-center gap-2.5" style={{ animation: "fade-in 0.3s ease-out" }}>
      <span aria-hidden className="h-px w-3.5 flex-shrink-0 bg-accent/60" />
      <p
        className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted"
        style={{ animation: "pulse-soft 1.6s ease-in-out infinite" }}
      >
        Thinking…
      </p>
    </div>
  );
}
