import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGoalTools, createTurnTracker } from "./goal-tools.js";

describe("goal-tools", () => {
  describe("createGoalTools", () => {
    it("returns four tool definitions without workingDir", () => {
      const { tools } = createGoalTools();
      expect(tools).toHaveLength(4);
      expect(tools[0]!.name).toBe("mark_task_complete");
      expect(tools[1]!.name).toBe("request_user_input");
      expect(tools[2]!.name).toBe("mark_task_failed");
      expect(tools[3]!.name).toBe("update_working_notes");
    });

    it("returns five tool definitions with workingDir", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "goal-tools-"));
      const { tools } = createGoalTools(dir);
      expect(tools).toHaveLength(5);
      expect(tools[4]!.name).toBe("delete_path");
    });

    it("signal is null initially", () => {
      const { getSignal } = createGoalTools();
      expect(getSignal()).toBeNull();
    });

    it("reset clears signal", async () => {
      const { tools, getSignal, reset } = createGoalTools();
      const markComplete = tools[0]!;
      await markComplete.execute("call-1", { summary: "Done" });
      expect(getSignal()).not.toBeNull();
      reset();
      expect(getSignal()).toBeNull();
    });
  });

  describe("mark_task_complete", () => {
    it("sets task_complete signal with summary", async () => {
      const { tools, getSignal } = createGoalTools();
      const markComplete = tools[0]!;
      const result = await markComplete.execute("call-1", { summary: "Created the file" });
      expect(result.content).toEqual([
        { type: "text", text: "Task marked complete. Do not call any more tools for this task." },
      ]);
      const signal = getSignal();
      expect(signal).toEqual({ type: "task_complete", summary: "Created the file" });
    });

    it("overwrites previous signal on second call", async () => {
      const { tools, getSignal } = createGoalTools();
      const markComplete = tools[0]!;
      await markComplete.execute("call-1", { summary: "First" });
      await markComplete.execute("call-2", { summary: "Second" });
      expect(getSignal()).toEqual({ type: "task_complete", summary: "Second" });
    });
  });

  describe("request_user_input", () => {
    it("sets user_input_needed signal with question", async () => {
      const { tools, getSignal } = createGoalTools();
      const requestInput = tools[1]!;
      const result = await requestInput.execute("call-1", {
        question: "What database?",
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: "User has been notified. This task is paused. Do not continue working on it.",
        },
      ]);
      const signal = getSignal();
      expect(signal).toEqual({ type: "user_input_needed", question: "What database?" });
    });

    it("captures optional context", async () => {
      const { tools, getSignal } = createGoalTools();
      const requestInput = tools[1]!;
      await requestInput.execute("call-1", {
        question: "Which port?",
        context: "Need to configure the server",
      });
      const signal = getSignal();
      expect(signal).toEqual({
        type: "user_input_needed",
        question: "Which port?",
        context: "Need to configure the server",
      });
    });
  });

  describe("signal precedence", () => {
    it("request_user_input then mark_task_complete returns blocked", async () => {
      const { tools, getSignal } = createGoalTools();
      const [markComplete, requestInput] = tools;
      await requestInput!.execute("call-1", { question: "What DB?" });
      await markComplete!.execute("call-2", { summary: "Done" });
      const signal = getSignal();
      expect(signal).toEqual({ type: "user_input_needed", question: "What DB?" });
    });

    it("mark_task_complete then request_user_input returns blocked", async () => {
      const { tools, getSignal } = createGoalTools();
      const [markComplete, requestInput] = tools;
      await markComplete!.execute("call-1", { summary: "Done" });
      await requestInput!.execute("call-2", { question: "Need port" });
      const signal = getSignal();
      expect(signal).toEqual({ type: "user_input_needed", question: "Need port" });
    });

    it("mark_task_complete is no-op after request_user_input", async () => {
      const { tools } = createGoalTools();
      const [markComplete, requestInput] = tools;
      await requestInput!.execute("call-1", { question: "What DB?" });
      const result = await markComplete!.execute("call-2", { summary: "Done" });
      expect(result.content[0]).toHaveProperty(
        "text",
        "This task is paused waiting for user input. Do not call any more tools.",
      );
    });

    it("reset clears both blocked and complete signals", async () => {
      const { tools, getSignal, reset } = createGoalTools();
      const [markComplete, requestInput] = tools;
      await requestInput!.execute("call-1", { question: "Q?" });
      await markComplete!.execute("call-2", { summary: "Done" });
      reset();
      expect(getSignal()).toBeNull();
    });
  });

  describe("mark_task_failed", () => {
    it("sets task_failed signal with structured fields", async () => {
      const { tools, getSignal } = createGoalTools();
      const markFailed = tools.find((t) => t.name === "mark_task_failed")!;
      const result = await markFailed.execute("call-1", {
        reason: "Build fails",
        whatTried: "Added dependency, ran build",
        errorType: "build_failure",
        suggestedNext: "Check TypeScript config",
        needsRevert: true,
      });
      expect(result.content).toEqual([
        { type: "text", text: "Task marked as failed. Do not call any more tools for this task." },
      ]);
      const signal = getSignal();
      expect(signal).toEqual({
        type: "task_failed",
        reason: "Build fails",
        whatTried: "Added dependency, ran build",
        errorType: "build_failure",
        suggestedNext: "Check TypeScript config",
        needsRevert: true,
      });
    });

    it("is no-op after request_user_input", async () => {
      const { tools } = createGoalTools();
      const requestInput = tools.find((t) => t.name === "request_user_input")!;
      const markFailed = tools.find((t) => t.name === "mark_task_failed")!;
      await requestInput.execute("c1", { question: "Q?" });
      const result = await markFailed.execute("c2", {
        reason: "r",
        whatTried: "w",
        errorType: "other",
        suggestedNext: "s",
        needsRevert: false,
      });
      expect((result.content[0] as { text: string }).text).toMatch(/paused waiting for user input/);
    });
  });

  describe("signal precedence with task_failed", () => {
    it("blocked wins over failed", async () => {
      const { tools, getSignal } = createGoalTools();
      const markFailed = tools.find((t) => t.name === "mark_task_failed")!;
      const requestInput = tools.find((t) => t.name === "request_user_input")!;
      await markFailed.execute("c1", {
        reason: "r",
        whatTried: "w",
        errorType: "other",
        suggestedNext: "s",
        needsRevert: false,
      });
      await requestInput.execute("c2", { question: "Q?" });
      expect(getSignal()!.type).toBe("user_input_needed");
    });

    it("failed wins over complete", async () => {
      const { tools, getSignal } = createGoalTools();
      const markComplete = tools.find((t) => t.name === "mark_task_complete")!;
      const markFailed = tools.find((t) => t.name === "mark_task_failed")!;
      await markComplete.execute("c1", { summary: "Done" });
      await markFailed.execute("c2", {
        reason: "r",
        whatTried: "w",
        errorType: "other",
        suggestedNext: "s",
        needsRevert: false,
      });
      expect(getSignal()!.type).toBe("task_failed");
    });

    it("reset clears all three signals", async () => {
      const { tools, getSignal, reset } = createGoalTools();
      const markComplete = tools.find((t) => t.name === "mark_task_complete")!;
      const requestInput = tools.find((t) => t.name === "request_user_input")!;
      const markFailed = tools.find((t) => t.name === "mark_task_failed")!;
      await requestInput.execute("c1", { question: "Q?" });
      await markFailed.execute("c2", {
        reason: "r",
        whatTried: "w",
        errorType: "other",
        suggestedNext: "s",
        needsRevert: false,
      });
      await markComplete.execute("c3", { summary: "Done" });
      reset();
      expect(getSignal()).toBeNull();
    });
  });

  describe("delete_path", () => {
    function setup() {
      const dir = mkdtempSync(path.join(tmpdir(), "goal-tools-del-"));
      const { tools } = createGoalTools(dir);
      const deletePath = tools.find((t) => t.name === "delete_path")!;
      return { dir, deletePath };
    }

    it("deletes a file inside the workspace", async () => {
      const { dir, deletePath } = setup();
      const filePath = path.join(dir, "foo.txt");
      writeFileSync(filePath, "hello");
      const result = await deletePath.execute("c1", { path: "foo.txt" });
      expect(result.content[0]).toHaveProperty("text", "Deleted: foo.txt");
      expect(() => readFileSync(filePath)).toThrow();
    });

    it("deletes a directory recursively", async () => {
      const { dir, deletePath } = setup();
      mkdirSync(path.join(dir, "sub", "deep"), { recursive: true });
      writeFileSync(path.join(dir, "sub", "deep", "a.txt"), "a");
      const result = await deletePath.execute("c1", { path: "sub", recursive: true });
      expect(result.content[0]).toHaveProperty("text", "Deleted: sub");
      expect(() => readFileSync(path.join(dir, "sub", "deep", "a.txt"))).toThrow();
    });

    it("rejects path traversal (../)", async () => {
      const { deletePath } = setup();
      const result = await deletePath.execute("c1", { path: "../escape" });
      expect((result.content[0] as { text: string }).text).toMatch(/Error.*escapes/i);
    });

    it("rejects deleting the workspace root", async () => {
      const { deletePath } = setup();
      const result = await deletePath.execute("c1", { path: "." });
      expect((result.content[0] as { text: string }).text).toMatch(
        /cannot delete the workspace root/i,
      );
    });

    it("refuses symlinks", async () => {
      const { dir, deletePath } = setup();
      const target = path.join(dir, "real.txt");
      writeFileSync(target, "data");
      symlinkSync(target, path.join(dir, "link.txt"));
      const result = await deletePath.execute("c1", { path: "link.txt" });
      expect((result.content[0] as { text: string }).text).toMatch(/symlink/i);
      // Original file should still exist
      expect(readFileSync(target, "utf-8")).toBe("data");
    });

    it("returns error for nonexistent path", async () => {
      const { deletePath } = setup();
      const result = await deletePath.execute("c1", { path: "nope.txt" });
      expect((result.content[0] as { text: string }).text).toMatch(/does not exist/i);
    });
  });

  describe("createTurnTracker", () => {
    it("starts with empty state", () => {
      const tracker = createTurnTracker();
      expect(tracker.toolCalls).toEqual([]);
      expect(tracker.notesWritten).toBe(false);
    });

    it("records tool calls", () => {
      const tracker = createTurnTracker();
      tracker.recordTool("read_file");
      tracker.recordTool("write_file");
      expect(tracker.toolCalls).toEqual(["read_file", "write_file"]);
    });

    it("marks notes written", () => {
      const tracker = createTurnTracker();
      tracker.markNotesWritten();
      expect(tracker.notesWritten).toBe(true);
    });

    it("resets all state", () => {
      const tracker = createTurnTracker();
      tracker.recordTool("bash");
      tracker.markNotesWritten();
      tracker.reset();
      expect(tracker.toolCalls).toEqual([]);
      expect(tracker.notesWritten).toBe(false);
    });
  });

  describe("setTurnTracker integration", () => {
    it("setTurnTracker is a function on goalTools", () => {
      const goalTools = createGoalTools();
      expect(typeof goalTools.setTurnTracker).toBe("function");
    });

    it("update_working_notes marks tracker as notes written", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "goal-tools-tracker-"));
      // We need a runId for working notes — use a fake goals dir
      const fakeRunId = "tracker-test-run";
      const goalTools = createGoalTools(dir, fakeRunId);
      const tracker = createTurnTracker();
      goalTools.setTurnTracker(tracker);
      goalTools.setActiveTask("step1");

      const updateNotes = goalTools.tools.find((t) => t.name === "update_working_notes")!;
      await updateNotes.execute("c1", { notes: "Test note" });

      expect(tracker.notesWritten).toBe(true);
    });

    it("null tracker does not crash update_working_notes", async () => {
      const fakeRunId = "tracker-null-test";
      const goalTools = createGoalTools(undefined, fakeRunId);
      goalTools.setTurnTracker(null);
      goalTools.setActiveTask("step1");

      const updateNotes = goalTools.tools.find((t) => t.name === "update_working_notes")!;
      const result = await updateNotes.execute("c1", { notes: "Test" });
      // Should succeed (or return error for no active task) but not crash
      expect(result.content).toBeDefined();
    });
  });
});
