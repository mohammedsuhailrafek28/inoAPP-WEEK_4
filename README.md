# Autonomous AI Learning Agent

**Week 4 — Generative AI Internship at InnoApp Technologies**

The Autonomous AI Learning Agent is the final evolution of the internship project — transforming the personalized learning system into an adaptive agent capable of planning study sessions, prioritizing concepts, generating learning materials, tracking progress, detecting learning gaps, and continuously recommending the student's next best action.

---

## Overview

Week 4 moves beyond answering questions and personalizing explanations.

The system can now actively help decide:

> **What should I study next, why should I study it, and how should I study it?**

It combines learning history, concept mastery, prerequisite relationships, available study time, practice performance, and exam goals to create an adaptive learning experience.

```text
Study Material
      +
Learning History
      +
Practice Performance
      +
Concept Relationships
      +
Available Study Time
      +
Exam Goal
      ↓
Learning Agent
      ↓
Analyze Current State
      ↓
Prioritize Concepts
      ↓
Generate Study Plan
      ↓
Create Study Materials
      ↓
Track Outcomes
      ↓
Detect Learning Gaps
      ↓
Recommend Next Action
      ↓
Adapt
```

---

## Core Features

### Learning Plan Generator

Students can generate study plans based on:

- Selected subject
- Available study time
- Current learning state
- Concept mastery
- Previous performance
- Prerequisite relationships

The planner allocates time to useful learning actions rather than generating a generic timetable.

```text
Student State
      ↓
Analyze Concepts
      ↓
Determine Priority
      ↓
Allocate Time
      ↓
Generate Learning Actions
```

---

## Autonomous Prioritization

The learning agent determines which concepts deserve attention first.

Instead of simply following a fixed topic order, prioritization can consider:

- Current mastery
- Previous attempts
- Weak concepts
- Unstudied concepts
- Prerequisite dependencies
- Revision requirements
- Available study time

This enables the application to recommend a **next best learning action**.

---

## Prerequisite-Aware Learning

Concept relationships are considered when generating recommendations.

For example:

```text
Hashing
   ↓
Rolling Hash
   ↓
Rabin-Karp
```

If a student struggles with Rabin-Karp because Rolling Hash is not sufficiently understood, the system can surface the prerequisite gap instead of repeatedly recommending the advanced concept.

This helps address the underlying learning problem rather than only reacting to the latest score.

---

## AI Study Materials

The system can generate learning materials tailored to the current learning context.

Supported material types include:

### Notes

Structured notes for reviewing a concept.

### Flashcards

Compact question-and-answer cards for recall and revision.

### Practice Questions

Adaptive practice activities for testing understanding.

### Teach-Back Mode

Students explain a concept in their own words and receive grounded feedback on their explanation.

This follows a Feynman-style learning approach:

```text
Learn Concept
      ↓
Explain in Your Own Words
      ↓
Compare Against Evidence
      ↓
Identify Missing Ideas
      ↓
Receive Feedback
      ↓
Improve Understanding
```

---

## Misconception Intervention Coach

Repeated mistakes can indicate more than a single incorrect answer.

The intervention system analyzes learning evidence and can identify when additional recovery support is appropriate.

Possible intervention situations include:

- Prerequisite gaps
- Repeated incorrect attempts
- Weak understanding
- Concepts requiring targeted recovery

```text
Practice Outcomes
      ↓
Learning Evidence
      ↓
Detect Learning Gap
      ↓
Identify Cause
      ↓
Recommend Recovery Action
```

Interventions are evidence-based and are not triggered simply because a concept is new.

---

## Progress Tracking

The Progress workspace tracks the student's learning state across concepts.

Concepts can be represented through learning stages such as:

```text
NEW
 ↓
LEARNING
 ↓
MASTERED
```

The system distinguishes between:

- Concepts with no learning evidence
- Concepts currently being learned
- Concepts supported by strong mastery evidence

This prevents unstudied concepts from being incorrectly presented as weaknesses.

---

## Adaptive Next Steps

Progress information is converted into actionable recommendations.

Instead of displaying only scores, the system answers:

```text
What happened?
      ↓
Why does it matter?
      ↓
What should I do next?
```

Recommendations can lead directly into learning, practice, revision, or recovery workflows.

---

## Exam Goal Mode

Students can provide an upcoming exam date and available daily study time.

The system uses the learning state to construct a multi-day adaptive roadmap.

Inputs include:

- Subject
- Exam date
- Daily study time
- Current mastery
- Learning evidence
- Concept priorities

Example:

```text
Exam Goal
   ↓
Current Learning State
   ↓
Readiness Analysis
   ↓
Concept Prioritization
   ↓
Multi-Day Roadmap
   ↓
Daily Learning Actions
```

The system does not fabricate progress for concepts without evidence.

---

## Learning Readiness

Exam Goal Mode provides a readiness view derived from available learning evidence.

The purpose is not simply to show a percentage, but to help students understand where preparation effort should be directed before the exam.

---

## Agent Activity

Important learning-agent actions can be recorded so that the application can provide visibility into how the learning experience evolves.

Examples include:

- Plan generation
- Learning recommendations
- Study-material generation
- Progress-driven actions
- Adaptive replanning

This makes the autonomous behavior easier to understand and inspect.

---

# Complete Learning Loop

Week 4 connects the major parts of the system into one continuous learning cycle.

```text
             ┌──────────────┐
             │ STUDY        │
             │ MATERIAL     │
             └──────┬───────┘
                    ↓
             ┌──────────────┐
             │ LEARN        │
             └──────┬───────┘
                    ↓
             ┌──────────────┐
             │ PRACTICE     │
             └──────┬───────┘
                    ↓
             ┌──────────────┐
             │ OUTCOMES     │
             └──────┬───────┘
                    ↓
             ┌──────────────┐
             │ PROGRESS     │
             │ ANALYSIS     │
             └──────┬───────┘
                    ↓
             ┌──────────────┐
             │ PRIORITIZE   │
             └──────┬───────┘
                    ↓
             ┌──────────────┐
             │ PLAN         │
             └──────┬───────┘
                    ↓
             ┌──────────────┐
             │ NEXT ACTION  │
             └──────┬───────┘
                    │
                    └────────────→ LEARN
```

The loop allows the learning experience to evolve as new student evidence becomes available.

---

# System Architecture

```text
                       ┌────────────────────┐
                       │      Student       │
                       └─────────┬──────────┘
                                 │
                                 ▼
                       ┌────────────────────┐
                       │ Learning Interface │
                       └─────────┬──────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
           ▼                     ▼                     ▼
 ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
 │ Study Material  │   │ Practice Data   │   │ Student Profile │
 └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │ Learning State       │
                    │ & Academic Memory    │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ Learning Agent       │
                    └───────────┬───────────┘
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                     │
          ▼                     ▼                     ▼
 ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
 │ Prioritization  │   │ Plan Generator  │   │ Intervention    │
 │ Engine          │   │                 │   │ Logic           │
 └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
          │                     │                     │
          └─────────────────────┼─────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │ Next Best Action     │
                    └───────────┬───────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ Adaptive Learning    │
                    │ Experience           │
                    └───────────────────────┘
```

---

# Technology Stack

| Technology | Purpose |
|---|---|
| Next.js | Full-stack application framework |
| React | Interactive learning interface |
| TypeScript | Type-safe application development |
| Tailwind CSS | Responsive UI |
| Google Gemini | AI generation and learning assistance |
| Supabase | Application data and persistence |
| PostgreSQL | Learning and student data |
| pgvector | Semantic retrieval |
| pdfjs-dist | PDF text extraction |

---

# Main Learning Areas

```text
LEARN
├── Document-grounded explanations
├── Personalized learning
├── Notes
├── Teach-Back
└── Concept understanding

PRACTICE
├── Adaptive questions
├── Concept selection
├── Difficulty handling
└── Learning outcomes

PLAN
├── Time-budget planning
├── Concept prioritization
├── Prerequisite awareness
├── Next best actions
└── Exam Goal roadmap

PROGRESS
├── Concept mastery
├── Learning evidence
├── Revision recommendations
├── Intervention detection
└── Recovery actions

STUDY MATERIALS
├── Notes
├── Flashcards
├── Practice
└── Teach-Back
```

---

# Cold-Start Experience

The application is designed to work even for a completely new student with no existing learning history.

The initial workflow is:

```text
Upload Material
      ↓
Generate a Plan
      OR
Start Practice
      ↓
Create Learning Evidence
      ↓
Personalization Improves
```

New concepts are represented honestly as **not yet studied** rather than being classified as weak.

As the student practices, the system gains more evidence and can produce increasingly personalized plans and recommendations.

---

# Getting Started

## 1. Clone the Repository

```bash
git clone <repository-url>
cd inoAPP-WEEK_4
```

## 2. Install Dependencies

```bash
npm install
```

## 3. Configure Environment Variables

Create `.env.local` using `.env.example` as the template.

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=

SUPABASE_URL=
SUPABASE_SECRET_KEY=

GEMINI_API_KEY=
```

Never commit API keys or private credentials.

## 4. Apply Database Migrations

Apply the migrations located in:

```text
supabase/migrations/
```

in their required order.

## 5. Run the Application

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

---

# Validation

The final Week 4 implementation was validated using the complete automated test suite along with lint and production build verification.

```bash
npm test
npm run lint
npm run build
```

Final validation:

```text
Automated Tests : 667 passed
Lint            : Passed
Production Build: Passed
```

---

# Internship Evolution

The four-week project evolves progressively rather than functioning as four disconnected applications.

### Week 1 — AI Study Assistant

```text
Question
   ↓
AI Explanation
```

### Week 2 — AI Document Assistant

```text
Study Material
   ↓
Retrieval
   ↓
Grounded Answer
   ↓
Citations
```

### Week 3 — Personalized AI Learning Engine

```text
Study Material
      +
Learning Activity
      +
Student Profile
      ↓
Personalized Learning
```

### Week 4 — Autonomous AI Learning Agent

```text
Learning State
      +
Performance
      +
Goals
      +
Available Time
      ↓
Analyze
      ↓
Prioritize
      ↓
Plan
      ↓
Teach
      ↓
Practice
      ↓
Evaluate
      ↓
Adapt
```

Week 4 completes the transition from a system that **responds to the student** into one that can also **guide the student's learning journey**.

---

# Week 4 Scope

## Implemented

- Time-aware learning plan generation
- Autonomous concept prioritization
- Prerequisite-aware recommendations
- Next-best-action generation
- Personalized notes
- Flashcards
- Adaptive practice
- Progress tracking
- Learning-stage tracking
- Revision recommendations
- Agent activity logging
- Adaptive replanning
- Exam Goal Mode
- Multi-day learning roadmaps
- Learning readiness
- Misconception intervention
- Recovery recommendations
- Grounded Teach-Back / Feynman Mode
- Honest cold-start experience
- Personalized learning workflow

---

# Final Outcome

The final system combines:

```text
Document Intelligence
        +
Retrieval-Augmented Generation
        +
Student Profiling
        +
Learning Memory
        +
Practice Analytics
        +
Concept Mastery
        +
Prerequisite Reasoning
        +
Adaptive Planning
        +
AI Study Materials
        +
Learning Interventions
        ↓
Autonomous Personalized Learning Agent
```

The result is a full-stack learning platform that does more than generate educational content — it uses learning evidence to continuously determine **what the student should do next**.

---

# Author

**Mohammed Suhail Rafek**  
AI & Data Science  
Chennai Institute of Technology
