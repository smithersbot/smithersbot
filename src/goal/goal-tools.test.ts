import { describe, expect, it } from "vitest";
import { createGoalTools } from "./goal-tools.js";

describe("goal-tools", () => {
  describe("createGoalTools", () => {
    it("returns two tool definitions", () => {
      const { tools } = createGoalTools();
      expect(tools).toHaveLength(2);
      expect(tools[0]!.name).toBe("mark_task_complete");
      expect(tools[1]!.name).toBe("request_user_input");
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
});
