import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  REPO_CHAT_CLAUDE_ALLOWED_TOOLS,
  REPO_CHAT_READ_ONLY_PROMPT,
  runRepoChatWorker,
} from "./repo-chat-worker.js";

const FIXED_UUID = "repo-chat-worker-test-uuid";
const RESPONSE_FILE_PATH = path.join(os.tmpdir(), `moltbot-rc-${FIXED_UUID}.md`);

describe("repo-chat-worker", () => {
  beforeEach(() => {
    runCliProcessMock.mockReset();
    getCodexAskForApprovalPlacementMock.mockReset();
    buildClaudeCodeEnvMock.mockReset();
    getCodexAskForApprovalPlacementMock.mockReturnValue("before_exec");
    buildClaudeCodeEnvMock.mockReturnValue({ TEST_ENV: "1" });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(FIXED_UUID);
    fs.rmSync(RESPONSE_FILE_PATH, { force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(RESPONSE_FILE_PATH, { force: true });
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
      expect(args).toContain("--output-format");
      expect(args).toContain("json");
      expect(args).not.toContain("stream-json");
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
      expect(args).not.toContain("--json");
    });

    it("supports Codex ask-for-approval placement after exec", () => {
      getCodexAskForApprovalPlacementMock.mockReturnValueOnce("after_exec");
      const args = buildCodexRepoChatArgs({
        prompt: "Explain src/telegram",
        workingDir: "/repo",
      });
      expect(args.slice(0, 4)).toEqual(["exec", "--ask-for-approval", "never", "--json"]);
    });

    it("passes response-file instruction prompt through Claude args", () => {
      const prompt = [
        "RESPONSE FILE (CRITICAL - READ THIS CAREFULLY):",
        `You MUST write your complete final response to: ${RESPONSE_FILE_PATH}`,
      ].join("\n");

      const args = buildClaudeRepoChatArgs({ prompt });
      const promptArg = args.at(-1) ?? "";

      expect(promptArg).toContain("RESPONSE FILE");
      expect(promptArg).toContain(RESPONSE_FILE_PATH);
    });

    it("passes response-file instruction prompt through Codex args", () => {
      const prompt = [
        "RESPONSE FILE (CRITICAL - READ THIS CAREFULLY):",
        `You MUST write your complete final response to: ${RESPONSE_FILE_PATH}`,
      ].join("\n");

      const args = buildCodexRepoChatArgs({
        prompt,
        workingDir: "/repo",
      });
      const promptArg = args.at(-1) ?? "";

      expect(promptArg).toContain("RESPONSE FILE");
      expect(promptArg).toContain(RESPONSE_FILE_PATH);
    });
  });

  describe("runRepoChatWorker", () => {
    it("reads response file and returns written content", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Repository answer from file\n", "utf-8");
        return {
          stdout: '{"session_id":"claude-session-42"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 120,
        };
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
      expect(call.env).toEqual({ TEST_ENV: "1" });
      expect(call.args.at(-1)).toContain("RESPONSE FILE");
      expect(call.args.at(-1)).toContain(RESPONSE_FILE_PATH);
      expect(result.text).toBe("Repository answer from file");
      expect(result.cliSessionId).toBe("claude-session-42");
    });

    it("repairs when response file is missing", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: '{"session_id":"claude-session-repair"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 44,
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(RESPONSE_FILE_PATH, "Recovered response", "utf-8");
          return {
            stdout: "",
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 55,
          };
        });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "Need repair path",
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      const repairCall = runCliProcessMock.mock.calls[1]?.[0] as {
        timeoutMs: number;
        args: string[];
      };
      expect(repairCall.timeoutMs).toBe(60_000);
      expect(repairCall.args).toContain("--resume");
      expect(repairCall.args).toContain("claude-session-repair");
      expect(repairCall.args.at(-1)).toContain("Your response file was not written or is empty");
      expect(result.text).toBe("Recovered response");
    });

    it("repairs when response file is empty", async () => {
      runCliProcessMock
        .mockImplementationOnce(async () => {
          fs.writeFileSync(RESPONSE_FILE_PATH, "  \n", "utf-8");
          return {
            stdout: '{"thread_id":"codex-thread-1"}',
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 25,
          };
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(RESPONSE_FILE_PATH, "Recovered from empty file", "utf-8");
          return {
            stdout: "",
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 26,
          };
        });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "Need codex repair path",
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      const repairCall = runCliProcessMock.mock.calls[1]?.[0] as {
        args: string[];
      };
      expect(repairCall.args).toContain("resume");
      expect(repairCall.args).toContain("codex-thread-1");
      expect(repairCall.args).not.toContain("--json");
      expect(repairCall.args.at(-1)).toContain("Write the file and nothing else.");
      expect(result.text).toBe("Recovered from empty file");
    });

    it("throws when repair also fails to produce a response file", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: '{"session_id":"claude-session-repair-fail"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 41,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 42,
        });

      await expect(
        runRepoChatWorker({
          backend: "claude_code",
          prompt: "repair should fail",
          workingDir: "/repo",
        }),
      ).rejects.toThrow(
        "Repo chat worker completed but did not write a response file, even after repair attempt.",
      );
      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
    });

    it("cleans up temp response file on success", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "cleanup success", "utf-8");
        return {
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 9,
        };
      });

      await runRepoChatWorker({
        backend: "claude_code",
        prompt: "cleanup check",
        workingDir: "/repo",
      });

      expect(fs.existsSync(RESPONSE_FILE_PATH)).toBe(false);
    });

    it("cleans up temp response file on error", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "cleanup error", "utf-8");
        throw new Error("cli launch failed");
      });

      await expect(
        runRepoChatWorker({
          backend: "claude_code",
          prompt: "cleanup error check",
          workingDir: "/repo",
        }),
      ).rejects.toThrow("cli launch failed");

      expect(fs.existsSync(RESPONSE_FILE_PATH)).toBe(false);
    });

    it("throws on timeout and still cleans up temp file", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "timeout path", "utf-8");
        return {
          stdout: "",
          stderr: "",
          timedOut: true,
          exitCode: null,
          signal: "SIGTERM",
          durationMs: 100,
        };
      });

      await expect(
        runRepoChatWorker({
          backend: "claude_code",
          prompt: "timeout check",
          workingDir: "/repo",
          timeoutMs: 2_000,
        }),
      ).rejects.toThrow("Repo chat worker timed out after 2000ms.");

      expect(fs.existsSync(RESPONSE_FILE_PATH)).toBe(false);
    });

    it("throws on non-zero exit and includes stderr details", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "repo chat cli failed hard",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 19,
      });

      await expect(
        runRepoChatWorker({
          backend: "claude_code",
          prompt: "non-zero exit check",
          workingDir: "/repo",
        }),
      ).rejects.toThrow("Repo chat worker failed (claude exit 1): repo chat cli failed hard");
    });

    it("extracts session id from stdout json line", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Answer", "utf-8");
        return {
          stdout: ["not json", '{"event":"x"}', '{"session_id":"claude-session-99"}'].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 21,
        };
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "status?",
        workingDir: "/repo",
      });

      expect(result.cliSessionId).toBe("claude-session-99");
    });

    it("extracts session id from multiline stdout json object", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Answer", "utf-8");
        return {
          stdout: '{\n  "session_id": "sess-multiline-456",\n  "result": "some text"\n}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 22,
        };
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "status?",
        workingDir: "/repo",
      });

      expect(result.cliSessionId).toBe("sess-multiline-456");
    });

    it("extracts session id from stderr when stdout is empty", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Answer", "utf-8");
        return {
          stdout: "",
          stderr: '{"session_id":"from-stderr-123"}',
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 23,
        };
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "status?",
        workingDir: "/repo",
      });

      expect(result.cliSessionId).toBe("from-stderr-123");
    });
  });
});
