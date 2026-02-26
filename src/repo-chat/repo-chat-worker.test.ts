import { beforeEach, describe, expect, it, vi } from "vitest";

const runCliProcessMock = vi.fn();
const getCodexAskForApprovalPlacementMock = vi.fn();
const buildClaudeCodeEnvMock = vi.fn();

vi.mock("../goal/cli-process.js", () => ({
  runCliProcess: (...args: unknown[]) => runCliProcessMock(...args),
}));

vi.mock("../goal/backend-availability.js", () => ({
  getCodexAskForApprovalPlacement: (...args: unknown[]) =>
    getCodexAskForApprovalPlacementMock(...args),
}));

vi.mock("../goal/claude-code-env.js", () => ({
  buildClaudeCodeEnv: (...args: unknown[]) => buildClaudeCodeEnvMock(...args),
}));

import {
  buildClaudeRepoChatArgs,
  buildCodexRepoChatArgs,
  parseRepoChatStreamJson,
  REPO_CHAT_CLAUDE_ALLOWED_TOOLS,
  REPO_CHAT_READ_ONLY_PROMPT,
  runRepoChatWorker,
} from "./repo-chat-worker.js";

describe("repo-chat-worker", () => {
  beforeEach(() => {
    runCliProcessMock.mockReset();
    getCodexAskForApprovalPlacementMock.mockReset();
    buildClaudeCodeEnvMock.mockReset();
    getCodexAskForApprovalPlacementMock.mockReturnValue("before_exec");
    buildClaudeCodeEnvMock.mockReturnValue({ TEST_ENV: "1" });
  });

  describe("args", () => {
    it("builds Claude resume args with read-only restrictions re-applied", () => {
      const args = buildClaudeRepoChatArgs({
        prompt: "What does this module do?",
        cliSessionId: "claude-session-1",
      });

      expect(args).toContain("--resume");
      expect(args).toContain("claude-session-1");
      expect(args).toContain("--verbose");
      expect(args).toContain("--allowedTools");
      expect(args).toContain(REPO_CHAT_CLAUDE_ALLOWED_TOOLS);
      expect(args).toContain("--append-system-prompt");
      const appendIdx = args.indexOf("--append-system-prompt");
      const appendedPrompt = args[appendIdx + 1] ?? "";
      expect(appendedPrompt).toContain(REPO_CHAT_READ_ONLY_PROMPT);
      expect(appendedPrompt).toContain("Moltbot");
    });

    it("builds Codex resume args with read-only sandbox re-applied", () => {
      const args = buildCodexRepoChatArgs({
        prompt: "Explain the tests in src/goal",
        workingDir: "/repo",
        cliSessionId: "thread-123",
      });

      expect(args).toContain("exec");
      expect(args).toContain("resume");
      expect(args).toContain("thread-123");
      expect(args).toContain("--sandbox");
      expect(args).toContain("read-only");
      expect(args).toContain("--ask-for-approval");
      expect(args).toContain("never");
    });

    it("supports Codex ask-for-approval placement after exec", () => {
      getCodexAskForApprovalPlacementMock.mockReturnValueOnce("after_exec");
      const args = buildCodexRepoChatArgs({
        prompt: "Explain src/telegram",
        workingDir: "/repo",
      });
      expect(args.slice(0, 4)).toEqual(["exec", "--ask-for-approval", "never", "--json"]);
    });
  });

  describe("parseRepoChatStreamJson", () => {
    it("prefers last assistant text over result text and extracts session id", () => {
      const output = [
        '{"type":"assistant","session_id":"claude-1","message":{"content":[{"type":"text","text":"draft"}]}}',
        '{"type":"assistant","session_id":"claude-1","message":{"content":[{"type":"text","text":"final answer"}]}}',
        '{"type":"result","is_error":false,"result":"full transcript text"}',
      ].join("\n");
      expect(parseRepoChatStreamJson(output)).toEqual({
        text: "final answer",
        cliSessionId: "claude-1",
      });
    });

    it("excludes tool use and tool result events from fallback text", () => {
      const output = [
        JSON.stringify({
          type: "assistant",
          session_id: "claude-2",
          message: { content: [{ type: "text", text: "assistant summary" }] },
        }),
        JSON.stringify({
          type: "tool_use",
          name: "Read",
          input: { path: "src/repo-chat/repo-chat-worker.ts", text: "file body" },
        }),
        JSON.stringify({
          type: "tool_result",
          content: [{ type: "text", text: "grep output and file contents" }],
        }),
      ].join("\n");

      expect(parseRepoChatStreamJson(output)).toEqual({
        text: "assistant summary",
        cliSessionId: "claude-2",
      });
    });

    it("uses only the last assistant event in multi-turn sessions", () => {
      const output = [
        JSON.stringify({
          type: "assistant",
          session_id: "claude-3",
          message: { content: [{ type: "text", text: "first assistant line" }] },
        }),
        JSON.stringify({
          type: "assistant",
          session_id: "claude-3",
          message: { content: [{ type: "text", text: "second assistant line" }] },
        }),
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "delta ignored because assistant exists" },
        }),
        JSON.stringify({ type: "result", is_error: false, result: "full transcript text" }),
      ].join("\n");

      expect(parseRepoChatStreamJson(output)).toEqual({
        text: "second assistant line",
        cliSessionId: "claude-3",
      });
    });

    it("excludes thinking blocks from assistant messages", () => {
      const output = JSON.stringify({
        type: "assistant",
        session_id: "claude-4",
        message: {
          content: [
            { type: "thinking", text: "do not show" },
            { type: "text", text: "visible text" },
            { type: "thinking", thinking: "also hidden" },
            { type: "text", text: " only" },
          ],
        },
      });

      expect(parseRepoChatStreamJson(output)).toEqual({
        text: "visible text only",
        cliSessionId: "claude-4",
      });
    });

    it("falls back to codex message items when no assistant exists", () => {
      const output = [
        '{"thread_id":"thread-2","item":{"type":"message","content":[{"type":"thinking","text":"skip me"},{"type":"text","text":"part 1"}]}}',
        '{"thread_id":"thread-2","item":{"type":"message","text":"part 2"}}',
      ].join("\n");
      expect(parseRepoChatStreamJson(output)).toEqual({
        text: "part 1\npart 2",
        cliSessionId: "thread-2",
      });
    });

    it("falls back to result text when no assistant event exists", () => {
      const output =
        '{"type":"result","is_error":false,"session_id":"claude-5","result":"final-only"}';
      expect(parseRepoChatStreamJson(output)).toEqual({
        text: "final-only",
        cliSessionId: "claude-5",
      });
    });

    it("truncates result fallback text when it exceeds the cap", () => {
      const longText = "a".repeat(9_000);
      const output = JSON.stringify({
        type: "result",
        session_id: "claude-6",
        is_error: false,
        result: longText,
      });

      const parsed = parseRepoChatStreamJson(output);
      expect(parsed.cliSessionId).toBe("claude-6");
      expect(parsed.text).toHaveLength(8_000);
      expect(parsed.text.endsWith("[Output truncated]")).toBe(true);
    });
  });

  describe("runRepoChatWorker", () => {
    it("runs Claude and returns parsed response/session id", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: [
          '{"type":"assistant","session_id":"claude-session-42","message":{"content":[{"type":"text","text":"draft"}]}}',
          '{"type":"assistant","session_id":"claude-session-42","message":{"content":[{"type":"text","text":"Repository answer"}]}}',
          '{"type":"result","is_error":false,"result":"Repository answer"}',
        ].join("\n"),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 120,
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "How is config loaded?",
        workingDir: "/repo",
      });

      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
      expect(call.command).toBe("claude");
      expect(call.args).toContain("--verbose");
      expect(call.args).toContain("--output-format");
      expect(call.args).toContain("stream-json");
      expect(buildClaudeCodeEnvMock).toHaveBeenCalledWith("subscription");
      expect(call.env).toEqual({ TEST_ENV: "1" });
      expect(result.text).toBe("Repository answer");
      expect(result.cliSessionId).toBe("claude-session-42");
    });

    it("uses configured Claude auth mode when provided", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: '{"type":"result","is_error":false,"result":"ok"}',
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 35,
      });

      await runRepoChatWorker({
        backend: "claude_code",
        prompt: "ping",
        workingDir: "/repo",
        claudeCodeAuth: "api_key",
      });

      expect(buildClaudeCodeEnvMock).toHaveBeenCalledWith("api_key");
    });

    it("runs Codex new session with --json and extracts thread id", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: '{"thread_id":"thread-88","item":{"type":"message","text":"Result text"}}\n',
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 99,
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "Summarize src/commands",
        workingDir: "/repo",
      });

      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        command: string;
        args: string[];
      };
      expect(call.command).toBe("codex");
      expect(call.args).toContain("--json");
      expect(call.args).toContain("--sandbox");
      expect(call.args).toContain("read-only");
      expect(result.text).toBe("Result text");
      expect(result.cliSessionId).toBe("thread-88");
    });

    it("runs Codex resume and keeps provided session id when output is plain text", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: "Follow-up answer",
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 88,
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "and what about tests?",
        workingDir: "/repo",
        cliSessionId: "thread-1",
      });

      const call = runCliProcessMock.mock.calls[0]?.[0] as { args: string[] };
      expect(call.args).toContain("resume");
      expect(call.args).toContain("thread-1");
      expect(call.args).toContain("--sandbox");
      expect(call.args).toContain("read-only");
      expect(result.text).toBe("Follow-up answer");
      expect(result.cliSessionId).toBe("thread-1");
    });

    it("throws when the worker exits non-zero", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "boom",
        timedOut: false,
        exitCode: 2,
        signal: null,
        durationMs: 10,
      });

      await expect(
        runRepoChatWorker({
          backend: "claude_code",
          prompt: "help",
          workingDir: "/repo",
        }),
      ).rejects.toThrow(/failed/);
    });

    it("extracts concise stream-json error text for non-zero exits", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout:
          '{"type":"result","is_error":true,"result":"Invalid API key · Fix external API key"}',
        stderr: "",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 20,
      });

      await expect(
        runRepoChatWorker({
          backend: "claude_code",
          prompt: "help",
          workingDir: "/repo",
        }),
      ).rejects.toThrow(/Invalid API key · Fix external API key/);
    });
  });
});
