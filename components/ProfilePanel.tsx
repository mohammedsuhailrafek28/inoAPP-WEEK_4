"use client";

import React, { useEffect, useState } from "react";
import type { StudentProfile } from "@/types/progress";

type FormState = {
  displayName: string;
  academicLevel: string;
  subjects: string; // comma-separated in the UI; split/joined at the API boundary only
  learningGoals: string;
  preferredExplanationStyle: StudentProfile["preferredExplanationStyle"];
  preferredDifficulty: StudentProfile["preferredDifficulty"];
  preferredPace: StudentProfile["preferredPace"];
  examplePreference: string;
};

function toForm(profile: StudentProfile): FormState {
  return {
    displayName: profile.displayName,
    academicLevel: profile.academicLevel,
    subjects: profile.subjects.join(", "),
    learningGoals: profile.learningGoals ?? "",
    preferredExplanationStyle: profile.preferredExplanationStyle,
    preferredDifficulty: profile.preferredDifficulty,
    preferredPace: profile.preferredPace,
    examplePreference: profile.examplePreference ?? "",
  };
}

const LABEL_CLASS = "text-[10px] font-medium uppercase tracking-[0.2em] text-muted";
const INPUT_CLASS =
  "mt-2 w-full rounded-lg border border-line bg-elevated-2 px-3 py-2.5 text-[13px] text-ink outline-none transition-colors focus:border-accent/55 disabled:cursor-not-allowed disabled:opacity-50";

export default function ProfilePanel() {
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/profile");
        const data = (await response.json()) as { profile: StudentProfile | null; error?: string };
        if (!response.ok) throw new Error(data.error || "Could not load your profile.");
        if (cancelled) return;
        if (data.profile) {
          setProfile(data.profile);
          setForm(toForm(data.profile));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load your profile.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    if (!form) return;
    setIsSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: form.displayName,
          academicLevel: form.academicLevel,
          subjects: form.subjects
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          learningGoals: form.learningGoals || null,
          preferredExplanationStyle: form.preferredExplanationStyle,
          preferredDifficulty: form.preferredDifficulty,
          preferredPace: form.preferredPace,
          examplePreference: form.examplePreference || null,
        }),
      });
      const data = (await response.json()) as { profile?: StudentProfile; error?: string };
      if (!response.ok || !data.profile) throw new Error(data.error || "Could not save your profile.");
      setProfile(data.profile);
      setForm(toForm(data.profile));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your profile.");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (!form) return <p className="text-[13px] text-muted">Your profile isn&rsquo;t available right now.</p>;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[12px] leading-relaxed text-muted">
        These preferences shape how explanations are pitched — they never override what the engine
        determines about your actual mastery or what to study next.
      </p>

      <div className="flex flex-col gap-5">
        <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-muted/50">About you</p>
        <label className="block">
          <span className={LABEL_CLASS}>Name</span>
          <input className={INPUT_CLASS} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} disabled={isSaving} />
        </label>

        <label className="block">
          <span className={LABEL_CLASS}>Academic level</span>
          <input className={INPUT_CLASS} value={form.academicLevel} onChange={(e) => setForm({ ...form, academicLevel: e.target.value })} disabled={isSaving} placeholder="e.g. Undergraduate, Year 2" />
        </label>

        <label className="block">
          <span className={LABEL_CLASS}>Subjects</span>
          <input className={INPUT_CLASS} value={form.subjects} onChange={(e) => setForm({ ...form, subjects: e.target.value })} disabled={isSaving} placeholder="Comma-separated, e.g. Data Structures, Algorithms" />
        </label>

        <label className="block">
          <span className={LABEL_CLASS}>Learning goals</span>
          <textarea className={`${INPUT_CLASS} min-h-[72px] resize-none`} value={form.learningGoals} onChange={(e) => setForm({ ...form, learningGoals: e.target.value })} disabled={isSaving} maxLength={500} />
        </label>
      </div>

      <div className="flex flex-col gap-5 border-t border-line pt-5">
        <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-muted/50">Learning preferences</p>
        <label className="block">
          <span className={LABEL_CLASS}>Preferred explanation style</span>
          <select className={INPUT_CLASS} value={form.preferredExplanationStyle} onChange={(e) => setForm({ ...form, preferredExplanationStyle: e.target.value as FormState["preferredExplanationStyle"] })} disabled={isSaving}>
            <option value="simple">Simple</option>
            <option value="detailed">Deep dive</option>
            <option value="exam">Exam-style</option>
          </select>
        </label>

        <label className="block">
          <span className={LABEL_CLASS}>Preferred difficulty</span>
          <select className={INPUT_CLASS} value={form.preferredDifficulty} onChange={(e) => setForm({ ...form, preferredDifficulty: e.target.value as FormState["preferredDifficulty"] })} disabled={isSaving}>
            <option value="auto">Adaptive (recommended)</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </label>

        <label className="block">
          <span className={LABEL_CLASS}>Preferred pace</span>
          <select className={INPUT_CLASS} value={form.preferredPace} onChange={(e) => setForm({ ...form, preferredPace: e.target.value as FormState["preferredPace"] })} disabled={isSaving}>
            <option value="self-paced">Self-paced</option>
            <option value="standard">Standard</option>
            <option value="accelerated">Accelerated</option>
          </select>
        </label>

        <label className="block">
          <span className={LABEL_CLASS}>Example preference</span>
          <input className={INPUT_CLASS} value={form.examplePreference} onChange={(e) => setForm({ ...form, examplePreference: e.target.value })} disabled={isSaving} placeholder="Optional, e.g. real-world examples" />
        </label>
      </div>

      {error && (
        <p role="alert" className="text-[12px] text-[#e9a991]">
          {error}
        </p>
      )}

      <div className="flex items-center gap-4 pt-1">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving}
          className="rounded-lg border border-line-strong px-4 py-2 text-[11px] font-medium uppercase tracking-[0.18em] text-ink transition-[color,border-color] hover:border-accent/60 hover:text-accent disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-[11px] uppercase tracking-[0.16em] text-accent-dim">Saved</span>}
      </div>

      {profile && <p className="border-t border-line pt-4 text-[10px] uppercase tracking-[0.16em] text-muted/50">Updated {new Date(profile.updatedAt).toLocaleDateString()}</p>}
    </div>
  );
}
