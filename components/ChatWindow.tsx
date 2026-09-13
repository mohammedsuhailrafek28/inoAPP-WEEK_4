"use client";

import React, { useRef, useEffect } from "react";
import { ChatMessage, ExplanationMode, ExamMarks } from "@/types/chat";
import MessageBubble, { TypingIndicator } from "@/components/MessageBubble";

interface ChatWindowProps {
  messages: ChatMessage[];
  isLoading: boolean;
  mode: ExplanationMode;
  marks: ExamMarks;
  conceptNames?: Record<string, string>;
}

export default function ChatWindow({
  messages,
  isLoading,
  mode,
  marks,
  conceptNames,
}: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-8 lg:py-12">
      <div className="mx-auto flex max-w-[680px] flex-col gap-10 lg:gap-11">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            mode={mode}
            marks={marks}
            conceptNames={conceptNames}
          />
        ))}
        {isLoading && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
