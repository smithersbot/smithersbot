import * as crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const LESSONS_FILENAME = "goal-lessons.json";

const LESSON_SOURCES = new Set(["ralph", "autocheck", "user_edit", "feedback", "worker"]);

export type LessonSource = "ralph" | "autocheck" | "user_edit" | "feedback" | "worker";

export type Lesson = {
  id: string;
  workingDir: string;
  pattern: string;
  lesson: string;
  source: LessonSource;
  runId: string;
  stepId?: string;
  createdAt: string;
};

function resolveLessonsPath(stateDir: string = resolveStateDir()): string {
  return path.join(stateDir, LESSONS_FILENAME);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function isLesson(value: unknown): value is Lesson {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return false;
  if (typeof record.workingDir !== "string") return false;
  if (typeof record.pattern !== "string") return false;
  if (typeof record.lesson !== "string") return false;
  if (typeof record.runId !== "string") return false;
  if (record.stepId != null && typeof record.stepId !== "string") return false;
  if (typeof record.createdAt !== "string") return false;
  if (typeof record.source !== "string" || !LESSON_SOURCES.has(record.source)) return false;
  return true;
}

export function loadLessons(): Lesson[] {
  const lessonsPath = resolveLessonsPath();
  if (!fs.existsSync(lessonsPath)) return [];

  try {
    const raw = fs.readFileSync(lessonsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLesson);
  } catch {
    return [];
  }
}

export function saveLessons(lessons: Lesson[]): void {
  atomicWriteJson(resolveLessonsPath(), lessons);
}

export function addLesson(lesson: Omit<Lesson, "id" | "createdAt">): Lesson {
  const next: Lesson = {
    ...lesson,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const lessons = loadLessons();
  lessons.push(next);
  saveLessons(lessons);
  return next;
}

export function getLessonsForContext(workingDir: string): Lesson[] {
  return loadLessons().filter((lesson) => lesson.workingDir === workingDir);
}

export function clearLessons(workingDir?: string): number {
  const lessons = loadLessons();
  if (workingDir === undefined) {
    const removed = lessons.length;
    saveLessons([]);
    return removed;
  }

  const kept = lessons.filter((lesson) => lesson.workingDir !== workingDir);
  const removed = lessons.length - kept.length;
  if (removed > 0) {
    saveLessons(kept);
  }
  return removed;
}

export function removeLessons(ids: string[]): number {
  if (ids.length === 0) return 0;

  const idSet = new Set(ids);
  const lessons = loadLessons();
  const kept = lessons.filter((lesson) => !idSet.has(lesson.id));
  const removed = lessons.length - kept.length;
  if (removed > 0) {
    saveLessons(kept);
  }
  return removed;
}
