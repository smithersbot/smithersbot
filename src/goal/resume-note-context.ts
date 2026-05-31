import type { ResumeNote, ResumeNoteSource } from "./types.js";

const MAX_WORKER_RESUME_NOTES = 5;

function describeResumeNoteSource(source: ResumeNoteSource): string {
  switch (source) {
    case "resume":
      return "Resume";
    case "add_details":
      return "Add Details";
    case "direct_reply":
      return "direct reply";
    case "goal_answer":
      return "/goal_answer";
    case "goal_resume":
      return "/goal_resume";
  }
}

function resumeNoteDedupKey(note: ResumeNote): string {
  return JSON.stringify([note.timestamp, note.source, note.affectedStepIds, note.userText ?? ""]);
}

export function selectWorkerResumeNotes(notes: ResumeNote[] | undefined): ResumeNote[] {
  if (!notes || notes.length === 0) return [];

  const selectedReversed: ResumeNote[] = [];
  const seen = new Set<string>();
  for (let index = notes.length - 1; index >= 0; index--) {
    const note = notes[index]!;
    const key = resumeNoteDedupKey(note);
    if (seen.has(key)) continue;
    seen.add(key);
    selectedReversed.push(note);
    if (selectedReversed.length >= MAX_WORKER_RESUME_NOTES) break;
  }
  return selectedReversed.reverse();
}

export function formatWorkerResumeNotes(notes: ResumeNote[] | undefined): string | null {
  const selected = selectWorkerResumeNotes(notes);
  if (selected.length === 0) return null;

  const lines: string[] = [];
  lines.push("GOAL-LEVEL RESUME NOTES:");
  lines.push(
    "These notes were added for the goal as a whole. Use them if they apply to your assigned step.",
  );
  for (const note of selected) {
    lines.push("");
    lines.push(`- Timestamp: ${note.timestamp}`);
    lines.push(`  Source: ${describeResumeNoteSource(note.source)}`);
    lines.push(`  Affected steps: ${note.affectedStepIds.join(", ") || "(none listed)"}`);
    if (note.userText && note.userText.trim().length > 0) {
      lines.push("  User text:");
      lines.push(note.userText);
    } else {
      lines.push("  User text: (none provided)");
    }
  }
  return lines.join("\n");
}
