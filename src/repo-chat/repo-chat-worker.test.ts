import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCliProcessMock = vi.fn();
const getCodexAskForApprovalPlacementMock = vi.fn();
const buildClaudeCodeEnvMock = vi.fn();
const loggerWarnMock = vi.fn();

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

vi.mock("../logging/logger.js", () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => loggerWarnMock(...args),
  }),
}));

import {
  buildClaudeRepoChatArgs,
  buildCodexRepoChatArgs,
  isPlaceholderRepoChatReply,
  REPO_CHAT_CLAUDE_ALLOWED_TOOLS,
  REPO_CHAT_CODEX_STYLE_PROMPT,
  REPO_CHAT_READ_ONLY_PROMPT,
  runRepoChatWorker,
} from "./repo-chat-worker.js";
import { REPO_CHAT_CONTEXT } from "./repo-chat-context.js";

const FIXED_UUID = "repo-chat-worker-test-uuid";
const RESPONSE_FILE_PATH = path.join(os.tmpdir(), `moltbot-rc-${FIXED_UUID}.md`);
const LAST_MESSAGE_FILE_PATH = path.join(os.tmpdir(), `moltbot-rc-${FIXED_UUID}-last.md`);

describe("repo-chat-worker", () => {
  beforeEach(() => {
    runCliProcessMock.mockReset();
    getCodexAskForApprovalPlacementMock.mockReset();
    buildClaudeCodeEnvMock.mockReset();
    loggerWarnMock.mockReset();
    getCodexAskForApprovalPlacementMock.mockReturnValue("before_exec");
    buildClaudeCodeEnvMock.mockReturnValue({ TEST_ENV: "1" });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(FIXED_UUID);
    fs.rmSync(RESPONSE_FILE_PATH, { force: true });
    fs.rmSync(LAST_MESSAGE_FILE_PATH, { force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(RESPONSE_FILE_PATH, { force: true });
    fs.rmSync(LAST_MESSAGE_FILE_PATH, { force: true });
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

    it("builds Codex initial args with workspace-write sandbox", () => {
      const args = buildCodexRepoChatArgs({
        prompt: "Explain the tests in src/goal",
        workingDir: "/repo",
        lastMessageFilePath: LAST_MESSAGE_FILE_PATH,
      });

      expect(args).toContain("exec");
      expect(args).toContain("--json");
      expect(args).toContain("--color");
      expect(args).toContain("never");
      expect(args).toContain("--sandbox");
      expect(args).toContain("workspace-write");
      expect(args).not.toContain("read-only");
      expect(args).toContain("--skip-git-repo-check");
      expect(args).toContain("--cd");
      expect(args).toContain("/repo");
      expect(args).toContain("--output-last-message");
      expect(args).toContain(LAST_MESSAGE_FILE_PATH);
      expect(args).not.toContain("resume");
    });

    it("builds Codex resume args with only flags supported by `codex exec resume --help`", () => {
      const prompt = "Explain the tests in src/goal";
      const args = buildCodexRepoChatArgs({
        prompt,
        workingDir: "/repo",
        lastMessageFilePath: LAST_MESSAGE_FILE_PATH,
        cliSessionId: "session-123",
      });

      expect(args).toContain("exec");
      expect(args).toContain("resume");
      expect(args).toContain("session-123");
      expect(args).toContain("--json");
      expect(args).toContain("--skip-git-repo-check");
      expect(args).not.toContain("--output-last-message");
      expect(args).not.toContain(LAST_MESSAGE_FILE_PATH);
      // Resume must NOT carry fresh-only flags — codex exec resume rejects these.
      expect(args).not.toContain("--color");
      expect(args).not.toContain("--sandbox");
      expect(args).not.toContain("workspace-write");
      expect(args).not.toContain("read-only");
      expect(args).not.toContain("--cd");
      expect(args).not.toContain("/repo");
      expect(args).not.toContain("--ask-for-approval");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args.at(-1)).toBe(prompt);
    });

    it("builds Codex resume args ordered with session id and output file before the prompt", () => {
      const prompt = "Explain repo chat resume args";
      const args = buildCodexRepoChatArgs({
        prompt,
        workingDir: "/repo",
        lastMessageFilePath: LAST_MESSAGE_FILE_PATH,
        cliSessionId: "session-resume-456",
      });

      const execIdx = args.indexOf("exec");
      const resumeIdx = args.indexOf("resume");
      expect(execIdx).toBe(0);
      expect(resumeIdx).toBe(1);
      expect(args[resumeIdx + 1]).toBe("session-resume-456");

      expect(args).not.toContain("--output-last-message");
      expect(args).not.toContain(LAST_MESSAGE_FILE_PATH);

      expect(args.at(-1)).toBe(prompt);
    });

    it("never uses the manual response file as the Codex output-last-message target", () => {
      const initialArgs = buildCodexRepoChatArgs({
        prompt: "Explain repo chat response files",
        workingDir: "/repo",
        lastMessageFilePath: LAST_MESSAGE_FILE_PATH,
      });
      const initialOutputIdx = initialArgs.indexOf("--output-last-message");
      expect(initialOutputIdx).toBeGreaterThanOrEqual(0);
      expect(initialArgs[initialOutputIdx + 1]).toBe(LAST_MESSAGE_FILE_PATH);
      expect(initialArgs[initialOutputIdx + 1]).not.toBe(RESPONSE_FILE_PATH);

      const resumeArgs = buildCodexRepoChatArgs({
        prompt: "Resume repo chat response files",
        workingDir: "/repo",
        lastMessageFilePath: LAST_MESSAGE_FILE_PATH,
        cliSessionId: "session-response-files",
      });
      expect(resumeArgs).not.toContain("--output-last-message");
      expect(resumeArgs).not.toContain(RESPONSE_FILE_PATH);
      expect(resumeArgs).not.toContain(LAST_MESSAGE_FILE_PATH);
    });

    it("omits --ask-for-approval on Codex resume regardless of placement", () => {
      for (const placement of ["before_exec", "after_exec", "unsupported"] as const) {
        getCodexAskForApprovalPlacementMock.mockReturnValueOnce(placement);
        const args = buildCodexRepoChatArgs({
          prompt: "resume placement check",
          workingDir: "/repo",
          cliSessionId: "session-placement",
        });
        expect(args).not.toContain("--ask-for-approval");
        expect(args[0]).toBe("exec");
        expect(args[1]).toBe("resume");
        expect(args[2]).toBe("session-placement");
        expect(args.at(-1)).toBe("resume placement check");
      }
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
        lastMessageFilePath: LAST_MESSAGE_FILE_PATH,
      });
      const promptArg = args.at(-1) ?? "";

      expect(promptArg).toContain("RESPONSE FILE");
      expect(promptArg).toContain(RESPONSE_FILE_PATH);
    });
  });

  describe("runRepoChatWorker", () => {
    it("detects placeholder repo-chat replies conservatively", () => {
      for (const text of ["", "  \n", "Done.", "Done", "OK", "Ok", "Okay", "Sure", "Completed"]) {
        expect(isPlaceholderRepoChatReply(text)).toBe(true);
      }

      for (const text of [
        "Final answer from codex stdout",
        "Done. The repo uses pnpm.",
        "## Summary\n\nDone.",
      ]) {
        expect(isPlaceholderRepoChatReply(text)).toBe(false);
      }
    });

    it("reads Codex manual response file for initial sessions", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Codex answer from file\n", "utf-8");
        fs.writeFileSync(LAST_MESSAGE_FILE_PATH, "Done.\n", "utf-8");
        return {
          stdout: '{"session_id":"codex-session-file","thread_id":"codex-thread-file"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 31,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "How does repo chat work?",
        workingDir: "/repo",
      });

      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        command: string;
        args: string[];
      };
      expect(call.command).toBe("codex");
      expect(call.args).toContain("--output-last-message");
      expect(call.args).toContain(LAST_MESSAGE_FILE_PATH);
      expect(call.args).not.toContain(RESPONSE_FILE_PATH);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CONTEXT);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CODEX_STYLE_PROMPT);
      expect(result.text).toBe("Codex answer from file");
      expect(result.cliSessionId).toBe("codex-thread-file");
    });

    it("returns manual markdown when Codex last-message and stdout are Done.", async () => {
      const fullMarkdown = "## Repo chat answer\n\n- First line\n- Second line";
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, `${fullMarkdown}\n`, "utf-8");
        fs.writeFileSync(LAST_MESSAGE_FILE_PATH, "Done.\n", "utf-8");
        return {
          stdout: [
            '{"type":"thread","session_id":"codex-session-624","thread_id":"codex-thread-624"}',
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Done."}]}}',
          ].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 624,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "Simulate the 6:24 Done regression",
        workingDir: "/repo",
      });

      expect(result.text).toBe(fullMarkdown);
      expect(result.text).not.toBe("Done.");
      expect(result.cliSessionId).toBe("codex-thread-624");
    });

    it("captures codex thread_id as cliSessionId on a successful turn", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Codex answer", "utf-8");
        return {
          stdout: '{"thread_id":"codex-thread-only"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 17,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "thread_id resumable",
        workingDir: "/repo",
      });

      expect(result.cliSessionId).toBe("codex-thread-only");
    });

    it("does not return cliSessionId on a failed codex turn even when stdout contains thread_id", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: '{"thread_id":"codex-thread-failed"}',
        stderr: "codex blew up",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 5,
      });

      let result: Awaited<ReturnType<typeof runRepoChatWorker>> | undefined;
      let caught: unknown;
      try {
        result = await runRepoChatWorker({
          backend: "codex",
          prompt: "failed turn",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      expect(result).toBeUndefined();
      expect((caught as Error | undefined)?.message).toContain(
        "Repo chat worker failed (codex exit 1)",
      );
    });

    it("does not return cliSessionId when codex response file is missing and repair fails (thread_id stdout)", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: '{"thread_id":"codex-thread-missing-file"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 11,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 12,
        });

      let result: Awaited<ReturnType<typeof runRepoChatWorker>> | undefined;
      let caught: unknown;
      try {
        result = await runRepoChatWorker({
          backend: "codex",
          prompt: "missing response file",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      expect(result).toBeUndefined();
      expect((caught as Error | undefined)?.message).toContain(
        "did not write a response file, even after repair attempt",
      );
    });

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
            stdout: '{"session_id":"codex-session-1","thread_id":"codex-thread-1"}',
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

    it("preserves cliSessionId across the repair pass when response file is empty", async () => {
      runCliProcessMock
        .mockImplementationOnce(async () => {
          fs.writeFileSync(RESPONSE_FILE_PATH, "", "utf-8");
          return {
            stdout: '{"type":"thread.started","thread_id":"codex-thread-preserve"}',
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 25,
          };
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(RESPONSE_FILE_PATH, "Recovered with preserved session", "utf-8");
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
        prompt: "Need codex repair path with session preservation",
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      const repairCall = runCliProcessMock.mock.calls[1]?.[0] as {
        args: string[];
      };
      expect(result.cliSessionId).toBe("codex-thread-preserve");
      expect(repairCall.args.join(" ")).toContain("resume codex-thread-preserve");
    });

    it("extracts codex response from stdout after repair fails to produce a response file", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: [
            '{"type":"thread","session_id":"codex-session-stdout","thread_id":"codex-thread-stdout"}',
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working through repo details"}]}}',
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Final answer from codex stdout"}]}}',
          ].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 27,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 28,
        });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "Explain repo stdout fallback",
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        args: string[];
      };
      expect(call.args).toContain("--output-last-message");
      expect(call.args).toContain(LAST_MESSAGE_FILE_PATH);
      expect(call.args).not.toContain(RESPONSE_FILE_PATH);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CONTEXT);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CODEX_STYLE_PROMPT);
      const repairCall = runCliProcessMock.mock.calls[1]?.[0] as {
        args: string[];
      };
      expect(repairCall.args).toContain("resume");
      expect(repairCall.args).toContain("codex-thread-stdout");
      expect(repairCall.args).not.toContain("--output-last-message");
      expect(repairCall.args.at(-1)).toContain("Your response file was not written or is empty");
      expect(result.text).toBe("Final answer from codex stdout");
      expect(result.cliSessionId).toBe("codex-thread-stdout");
    });

    it("extracts codex response from stdout for resumed sessions after repair fails", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: [
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Repair should run first"}]}}',
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Resumed final answer from codex stdout"}]}}',
          ].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 28,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 29,
        });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "Explain resumed repo stdout fallback",
        workingDir: "/repo",
        cliSessionId: "codex-resume-thread",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        args: string[];
      };
      expect(call.args).not.toContain("--output-last-message");
      expect(call.args).not.toContain(RESPONSE_FILE_PATH);
      expect(call.args).not.toContain(LAST_MESSAGE_FILE_PATH);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CONTEXT);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CODEX_STYLE_PROMPT);
      const repairCall = runCliProcessMock.mock.calls[1]?.[0] as {
        args: string[];
      };
      expect(repairCall.args).toContain("resume");
      expect(repairCall.args).toContain("codex-resume-thread");
      expect(repairCall.args).not.toContain("--output-last-message");
      expect(repairCall.args.at(-1)).toContain("Your response file was not written or is empty");
      expect(result.text).toBe("Resumed final answer from codex stdout");
      expect(result.cliSessionId).toBe("codex-resume-thread");
    });

    it("returns repaired content instead of placeholder codex stdout", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: [
            '{"type":"thread","session_id":"codex-session-placeholder"}',
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Done."}]}}',
          ].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 30,
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(RESPONSE_FILE_PATH, "Recovered repo answer", "utf-8");
          return {
            stdout: "",
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 31,
          };
        });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "placeholder should repair",
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      expect(result.text).toBe("Recovered repo answer");
    });

    it("returns repaired content when manual file is missing and last-message fallback is Done.", async () => {
      runCliProcessMock
        .mockImplementationOnce(async () => {
          fs.writeFileSync(LAST_MESSAGE_FILE_PATH, "Done.\n", "utf-8");
          return {
            stdout: [
              '{"type":"thread","session_id":"codex-session-last-placeholder"}',
              '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Done."}]}}',
            ].join("\n"),
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 36,
          };
        })
        .mockImplementationOnce(async () => {
          fs.writeFileSync(RESPONSE_FILE_PATH, "Recovered after missing manual file", "utf-8");
          return {
            stdout: "",
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 37,
          };
        });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "missing manual should repair before Done fallback",
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      expect(result.text).toBe("Recovered after missing manual file");
    });

    it("rejects placeholder codex stdout when repair fails", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: [
            '{"type":"thread","session_id":"codex-session-placeholder-fail"}',
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Done."}]}}',
          ].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 32,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 33,
        });

      await expect(
        runRepoChatWorker({
          backend: "codex",
          prompt: "placeholder should fail",
          workingDir: "/repo",
        }),
      ).rejects.toThrow(
        "Repo chat worker completed but did not write a response file, even after repair attempt. (placeholder stdout reply rejected)",
      );
      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
    });

    it("rejects Done last-message and stdout fallbacks when repair fails", async () => {
      runCliProcessMock
        .mockImplementationOnce(async () => {
          fs.writeFileSync(LAST_MESSAGE_FILE_PATH, "Done.\n", "utf-8");
          return {
            stdout: [
              '{"type":"thread","session_id":"codex-session-last-placeholder-fail"}',
              '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Done."}]}}',
            ].join("\n"),
            stderr: "",
            timedOut: false,
            exitCode: 0,
            signal: null,
            durationMs: 38,
          };
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 39,
        });

      await expect(
        runRepoChatWorker({
          backend: "codex",
          prompt: "last-message placeholder should fail",
          workingDir: "/repo",
        }),
      ).rejects.toThrow(
        "Repo chat worker completed but did not write a response file, even after repair attempt. (placeholder stdout reply rejected)",
      );
      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
    });

    it("rejects OK placeholder codex stdout when repair fails", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout:
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"OK"}]}}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 34,
        })
        .mockResolvedValueOnce({
          stdout: "",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 35,
        });

      await expect(
        runRepoChatWorker({
          backend: "codex",
          prompt: "ok placeholder should fail",
          workingDir: "/repo",
        }),
      ).rejects.toThrow("placeholder stdout reply rejected");
      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
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
        fs.writeFileSync(LAST_MESSAGE_FILE_PATH, "Done.", "utf-8");
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
      expect(fs.existsSync(LAST_MESSAGE_FILE_PATH)).toBe(false);
    });

    it("cleans up temp response file on error", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "cleanup error", "utf-8");
        fs.writeFileSync(LAST_MESSAGE_FILE_PATH, "Done.", "utf-8");
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
      expect(fs.existsSync(LAST_MESSAGE_FILE_PATH)).toBe(false);
    });

    it("throws on timeout and still cleans up temp file", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "timeout path", "utf-8");
        fs.writeFileSync(LAST_MESSAGE_FILE_PATH, "Done.", "utf-8");
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
      expect(fs.existsSync(LAST_MESSAGE_FILE_PATH)).toBe(false);
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

    it("uses the latest codex session id when multiple thread events appear", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Answer", "utf-8");
        return {
          stdout: [
            '{"type":"thread.started","thread_id":"codex-thread-old"}',
            '{"type":"turn.started"}',
            '{"type":"thread.started","thread_id":"codex-thread-new"}',
          ].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 21,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "status?",
        workingDir: "/repo",
      });

      expect(result.cliSessionId).toBe("codex-thread-new");
    });

    it("extracts nested codex session_configured id", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Answer", "utf-8");
        return {
          stdout: [
            '{"type":"turn.started"}',
            '{"type":"session_configured","session_configured":{"id":"codex-nested-session"}}',
          ].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 21,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "status?",
        workingDir: "/repo",
      });

      expect(result.cliSessionId).toBe("codex-nested-session");
    });

    it("returns undefined when no session id event is present", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Answer", "utf-8");
        return {
          stdout: ['{"type":"turn.started"}', '{"type":"turn.completed"}'].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 21,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "status?",
        workingDir: "/repo",
      });

      expect(result.cliSessionId).toBeUndefined();
      expect(result.text).toBe(
        "Answer\n\n⚠️ Note: this codex run did not return a session id; the next reply will start a fresh chat.",
      );
      expect(loggerWarnMock).toHaveBeenCalledTimes(1);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        "codex emitted no session id; next /repo_chat turn will start a new conversation",
        { runId: undefined, workerPath: "/repo" },
      );
    });

    it("does not warn or footer on a codex resume path without a new session id", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Answer", "utf-8");
        return {
          stdout: ['{"type":"turn.started"}', '{"type":"turn.completed"}'].join("\n"),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 21,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "status?",
        workingDir: "/repo",
        cliSessionId: "codex-existing-session",
      });

      expect(result.cliSessionId).toBe("codex-existing-session");
      expect(result.text).toBe("Answer");
      expect(loggerWarnMock).not.toHaveBeenCalled();
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

    it("extracts latest session id from Claude Code JSON array stderr (real format)", async () => {
      const realStderr = JSON.stringify([
        {
          type: "system",
          subtype: "init",
          session_id: "797f6446-af22-416e-884d-849f1a06ca61-old",
          tools: ["Read", "Glob", "Grep", "Bash"],
          model: "claude-opus-4-6",
        },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
          session_id: "797f6446-af22-416e-884d-849f1a06ca61",
        },
        {
          type: "result",
          subtype: "success",
          result: "hello",
          session_id: "797f6446-af22-416e-884d-849f1a06ca61",
          duration_ms: 4426,
        },
      ]);

      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Answer", "utf-8");
        return {
          stdout: "",
          stderr: realStderr,
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 4426,
        };
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "say hello",
        workingDir: "/repo",
      });

      expect(result.cliSessionId).toBe("797f6446-af22-416e-884d-849f1a06ca61");
    });
  });
});
