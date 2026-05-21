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

vi.mock("../goal/claude-code-env.js", async () => {
  const actual = await vi.importActual<typeof import("../goal/claude-code-env.js")>(
    "../goal/claude-code-env.js",
  );
  return {
    ...actual,
    buildClaudeCodeEnv: (...args: unknown[]) => buildClaudeCodeEnvMock(...args),
  };
});

vi.mock("../logging/logger.js", () => ({
  getLogger: () => ({
    warn: (...args: unknown[]) => loggerWarnMock(...args),
  }),
}));

import {
  buildClaudeRepoChatArgs,
  buildCodexRepoChatArgs,
  extractResponseFromCodexStdout,
  isPlaceholderRepoChatReply,
  REPO_CHAT_CLAUDE_ALLOWED_TOOLS,
  REPO_CHAT_CODEX_STYLE_PROMPT,
  REPO_CHAT_READ_ONLY_PROMPT,
  resolveRepoChatExecutionRoot,
  runRepoChatWorker,
} from "./repo-chat-worker.js";
import { REPO_CHAT_CONTEXT } from "./repo-chat-context.js";
import { EMPTY_MCP_CONFIG_PATH } from "../goal/claude-code-mcp-isolation.js";

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

    it("uses a repo-chat Claude tool list without Write or unrestricted Bash", () => {
      const tools = REPO_CHAT_CLAUDE_ALLOWED_TOOLS.split(",");

      expect(tools).toContain("Read");
      expect(tools).toContain("Glob");
      expect(tools).toContain("Grep");
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Bash");
      expect(tools).toEqual(
        expect.arrayContaining([
          "Bash(git log:*)",
          "Bash(git diff:*)",
          "Bash(git show:*)",
          "Bash(rg:*)",
          "Bash(ls:*)",
          "Bash(wc:*)",
          "Bash(find:*)",
        ]),
      );
    });

    it("isolates Claude from global MCP config with strict empty MCP flags", () => {
      const args = buildClaudeRepoChatArgs({
        prompt: "Explain repo structure",
        model: "claude-sonnet-4-5",
        cliSessionId: "claude-session-mcp",
      });

      expect(args).toContain("--strict-mcp-config");
      expect(args).toContain("--mcp-config");
      const mcpIdx = args.indexOf("--mcp-config");
      expect(args[mcpIdx + 1]).toBe(EMPTY_MCP_CONFIG_PATH);

      // MCP flags must come before --model / --resume / prompt so they are part of
      // the static portion of the args list (and the prompt remains last).
      const strictIdx = args.indexOf("--strict-mcp-config");
      const modelIdx = args.indexOf("--model");
      const resumeIdx = args.indexOf("--resume");
      const promptIdx = args.length - 1;
      expect(strictIdx).toBeLessThan(modelIdx);
      expect(mcpIdx).toBeLessThan(modelIdx);
      expect(strictIdx).toBeLessThan(resumeIdx);
      expect(mcpIdx).toBeLessThan(resumeIdx);
      expect(strictIdx).toBeLessThan(promptIdx);
      expect(mcpIdx).toBeLessThan(promptIdx);

      // The prompt is still the last arg.
      expect(args.at(-1)).toBe("Explain repo structure");

      // The empty MCP config file exists and contains exactly { "mcpServers": {} }.
      const raw = fs.readFileSync(EMPTY_MCP_CONFIG_PATH, "utf-8");
      expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
    });

    it("includes strict empty MCP flags on initial Claude args without a session id", () => {
      const args = buildClaudeRepoChatArgs({ prompt: "Initial repo question" });
      expect(args).toContain("--strict-mcp-config");
      expect(args).toContain("--mcp-config");
      const mcpIdx = args.indexOf("--mcp-config");
      expect(args[mcpIdx + 1]).toBe(EMPTY_MCP_CONFIG_PATH);
      expect(args.at(-1)).toBe("Initial repo question");
    });

    it("does not add MCP isolation flags to Codex initial args", () => {
      const args = buildCodexRepoChatArgs({
        prompt: "Codex initial",
        workingDir: "/repo",
        lastMessageFilePath: LAST_MESSAGE_FILE_PATH,
      });
      expect(args).not.toContain("--strict-mcp-config");
      expect(args).not.toContain("--mcp-config");
    });

    it("does not add MCP isolation flags to Codex resume args", () => {
      const args = buildCodexRepoChatArgs({
        prompt: "Codex resume",
        workingDir: "/repo",
        cliSessionId: "codex-resume-no-mcp",
      });
      expect(args).not.toContain("--strict-mcp-config");
      expect(args).not.toContain("--mcp-config");
    });

    it("builds Codex initial args with read-only sandbox", () => {
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
      expect(args).toContain("read-only");
      expect(args).not.toContain("workspace-write");
      expect(args).toContain("--skip-git-repo-check");
      expect(args).toContain("--cd");
      expect(args).toContain("/repo");
      expect(args).toContain("net.allowed=false");
      expect(args).toContain("--output-last-message");
      expect(args).toContain(LAST_MESSAGE_FILE_PATH);
      expect(args).not.toContain("resume");
      expect(args.join(" ")).not.toContain("danger-full-access");
      expect(args.join(" ")).not.toContain("dangerously-bypass");
    });

    it("runs managed repo chat from the agent root so workspaces and history are readable", () => {
      const originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
      const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-chat-agent-root-"));
      process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
      try {
        const agentRoot = path.join(managedRoot, "agent");
        const repoDir = path.join(agentRoot, "workspaces", "smithersbot", "repo");
        const historyDir = path.join(agentRoot, "history", "goals", "smithersbot", "run-1");
        const privateEnvDir = path.join(managedRoot, "private", "env", "smithersbot");
        fs.mkdirSync(repoDir, { recursive: true });
        fs.mkdirSync(historyDir, { recursive: true });
        fs.mkdirSync(privateEnvDir, { recursive: true });

        const args = buildCodexRepoChatArgs({
          prompt: "Read README and history",
          workingDir: repoDir,
        });
        const cdIdx = args.indexOf("--cd");
        expect(args[cdIdx + 1]).toBe(agentRoot);
        expect(resolveRepoChatExecutionRoot(repoDir)).toBe(agentRoot);
        expect(args.join(" ")).not.toContain(path.join(managedRoot, "private"));
        expect(path.relative(agentRoot, historyDir)).toBe(
          path.join("history", "goals", "smithersbot", "run-1"),
        );
        expect(path.relative(agentRoot, privateEnvDir).startsWith("..")).toBe(true);
      } finally {
        if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
        else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
        fs.rmSync(managedRoot, { recursive: true, force: true });
      }
    });

    it("rejects repo chat execution from SmithersBot private paths", () => {
      const originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
      const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-chat-private-root-"));
      process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
      try {
        const privateEnvDir = path.join(managedRoot, "private", "env", "smithersbot");
        expect(() =>
          buildCodexRepoChatArgs({
            prompt: "Read private env",
            workingDir: privateEnvDir,
          }),
        ).toThrow(/private paths/);
      } finally {
        if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
        else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
        fs.rmSync(managedRoot, { recursive: true, force: true });
      }
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

    it("passes final-assistant-message instruction prompt through Claude args", () => {
      const prompt = [
        "FINAL RESPONSE (CRITICAL - READ THIS CAREFULLY):",
        "Your final reply is whatever you print as the assistant message.",
      ].join("\n");

      const args = buildClaudeRepoChatArgs({ prompt });
      const promptArg = args.at(-1) ?? "";

      expect(promptArg).toContain("FINAL RESPONSE");
      expect(promptArg).toContain(
        "Your final reply is whatever you print as the assistant message.",
      );
      expect(promptArg).not.toContain("cat <<");
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

    it("inserts `--` end-of-options separator immediately before the prompt to prevent variadic --mcp-config from swallowing it", () => {
      const args = buildClaudeRepoChatArgs({ prompt: "Some user question" });
      // The prompt is the final positional arg.
      expect(args.at(-1)).toBe("Some user question");
      // The penultimate arg is the `--` end-of-options separator.
      expect(args.at(-2)).toBe("--");
      // The element after `--mcp-config` is the empty MCP config path — never the prompt.
      const mcpIdx = args.indexOf("--mcp-config");
      expect(mcpIdx).toBeGreaterThanOrEqual(0);
      expect(args[mcpIdx + 1]).toBe(EMPTY_MCP_CONFIG_PATH);
      expect(args[mcpIdx + 1]).not.toBe("Some user question");
    });

    it("preserves MCP isolation invariants when the prompt is a multi-KB RESPONSE FILE instruction", () => {
      const responseFilePreamble = [
        "FINAL RESPONSE (CRITICAL - READ THIS CAREFULLY):",
        "Your final reply is whatever you print as the assistant message.",
      ].join("\n");
      // Pad to multi-KB to simulate the live failure payload.
      const userQuestion = "Please explain how the goal system schedules tasks.\n".repeat(200);
      const prompt = `${responseFilePreamble}\n\n---\n\nUser question:\n${userQuestion}`;
      expect(prompt.length).toBeGreaterThan(4_000);

      const args = buildClaudeRepoChatArgs({
        prompt,
        cliSessionId: "claude-session-xyz",
        model: "claude-sonnet-4-5",
      });

      // (1) `--strict-mcp-config` is present.
      expect(args).toContain("--strict-mcp-config");
      // (2) `--mcp-config` is present as an exact element.
      expect(args).toContain("--mcp-config");
      const mcpIdx = args.indexOf("--mcp-config");
      // (3) The element immediately after `--mcp-config` is the empty MCP config path.
      expect(args[mcpIdx + 1]).toBe(EMPTY_MCP_CONFIG_PATH);
      expect(typeof args[mcpIdx + 1]).toBe("string");
      expect(args[mcpIdx + 1]).not.toBe("");
      // (4) The path exists on disk and parses to {mcpServers:{}}.
      const raw = fs.readFileSync(EMPTY_MCP_CONFIG_PATH, "utf-8");
      expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
      // (5) The prompt is the FINAL positional arg.
      expect(args.at(-1)).toBe(prompt);
      // (6) The prompt is never equal to the value of --mcp-config.
      expect(args[mcpIdx + 1]).not.toBe(prompt);
      // `--` separator sits between --mcp-config <path> (and any --resume/--model)
      // and the trailing prompt to defeat claude's variadic <configs...> parsing.
      expect(args.at(-2)).toBe("--");
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
      const prevTelegram = process.env.TELEGRAM_BOT_TOKEN;
      const prevGateway = process.env.CLAWDBOT_GATEWAY_TOKEN;
      const prevOauth = process.env.GITHUB_OAUTH_TOKEN;
      const prevCustomToken = process.env.CUSTOM_SERVICE_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = "telegram-secret";
      process.env.CLAWDBOT_GATEWAY_TOKEN = "gateway-secret";
      process.env.GITHUB_OAUTH_TOKEN = "oauth-secret";
      process.env.CUSTOM_SERVICE_TOKEN = "custom-token-secret";
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

      let result!: Awaited<ReturnType<typeof runRepoChatWorker>>;
      try {
        result = await runRepoChatWorker({
          backend: "codex",
          prompt: "How does repo chat work?",
          workingDir: "/repo",
        });
      } finally {
        if (prevTelegram === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = prevTelegram;
        if (prevGateway === undefined) delete process.env.CLAWDBOT_GATEWAY_TOKEN;
        else process.env.CLAWDBOT_GATEWAY_TOKEN = prevGateway;
        if (prevOauth === undefined) delete process.env.GITHUB_OAUTH_TOKEN;
        else process.env.GITHUB_OAUTH_TOKEN = prevOauth;
        if (prevCustomToken === undefined) delete process.env.CUSTOM_SERVICE_TOKEN;
        else process.env.CUSTOM_SERVICE_TOKEN = prevCustomToken;
      }

      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
      expect(call.command).toBe("codex");
      expect(call.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(call.env.CLAWDBOT_GATEWAY_TOKEN).toBeUndefined();
      expect(call.env.GITHUB_OAUTH_TOKEN).toBeUndefined();
      expect(call.env.CUSTOM_SERVICE_TOKEN).toBeUndefined();
      expect(call.args).toContain("--output-last-message");
      expect(call.args).toContain(LAST_MESSAGE_FILE_PATH);
      expect(call.args).not.toContain(RESPONSE_FILE_PATH);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CONTEXT);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CODEX_STYLE_PROMPT);
      expect(result.text).toBe("Codex answer from file");
      expect(result.cliSessionId).toBe("codex-thread-file");
    });

    it("redacts secret values from response files and captured subprocess output", async () => {
      vi.stubEnv("TELEGRAM_BOT_TOKEN", "FAKE_TELEGRAM_SECRET_123");
      vi.stubEnv("SMITHERSBOT_GATEWAY_TOKEN", "FAKE_GATEWAY_SECRET_456");
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(RESPONSE_FILE_PATH, "Do not leak FAKE_TELEGRAM_SECRET_123\n", "utf-8");
        return {
          stdout: "stdout has FAKE_GATEWAY_SECRET_456",
          stderr: "stderr has FAKE_TELEGRAM_SECRET_123",
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
        cliSessionId: "codex-session-existing",
      });

      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("FAKE_TELEGRAM_SECRET_123");
      expect(result.stdout).toContain("[REDACTED]");
      expect(result.stdout).not.toContain("FAKE_GATEWAY_SECRET_456");
      expect(result.stderr).toContain("[REDACTED]");
      expect(result.stderr).not.toContain("FAKE_TELEGRAM_SECRET_123");
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
        "completed without a deliverable response after CLI extraction",
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
      expect(call.args.at(-1)).toContain("FINAL RESPONSE");
      expect(call.args.at(-1)).toContain(
        "Your final reply is whatever you print as the assistant message.",
      );
      expect(call.args.at(-1)).not.toContain("cat <<");
      expect(call.args).toContain("--strict-mcp-config");
      expect(call.args).toContain("--mcp-config");
      const mcpIdx = call.args.indexOf("--mcp-config");
      expect(call.args[mcpIdx + 1]).toBe(EMPTY_MCP_CONFIG_PATH);
      expect(result.text).toBe("Repository answer from file");
      expect(result.cliSessionId).toBe("claude-session-42");
    });

    it("extracts Claude final assistant text from JSON stdout without a response file", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "claude-json-session",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Draft answer" }],
            },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Final Claude answer from stdout" }],
            },
            session_id: "claude-json-session",
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            result: "Final Claude answer from stdout",
            session_id: "claude-json-session",
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 120,
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "How is repo chat contained?",
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
      const call = runCliProcessMock.mock.calls[0]?.[0] as { args: string[] };
      expect(call.args.at(-1)).toContain("FINAL RESPONSE");
      expect(call.args.at(-1)).not.toContain("cat <<");
      expect(result.text).toBe("Final Claude answer from stdout");
      expect(result.cliSessionId).toBe("claude-json-session");
    });

    it("regression: answers the launch-kit readiness prompt from Claude stdout without writing a response file", async () => {
      const launchKitPrompt =
        'Is this prompt ready to run? "/new_goal Build the SmithersBot launch kit: create the smithersbot.com landing page, a launch posting cadence for X, LinkedIn, and any other relevant channels, and launch posts in my voice. Use README.md, SETUP.md, and review every asset and reference inside internal/launch-inputs for branding, screenshots, copy direction and layout references."';
      runCliProcessMock.mockResolvedValueOnce({
        stdout: [
          JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "claude-launch-kit-session",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "The prompt is close, but I would narrow the launch channels and define success criteria before running it.",
                },
              ],
            },
            session_id: "claude-launch-kit-session",
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 121,
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: launchKitPrompt,
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(RESPONSE_FILE_PATH)).toBe(false);
      const call = runCliProcessMock.mock.calls[0]?.[0] as { args: string[] };
      expect(call.args.at(-1)).toContain(launchKitPrompt);
      expect(call.args.at(-1)).not.toContain("cat <<");
      expect(result.text).toContain("narrow the launch channels");
      expect(result.cliSessionId).toBe("claude-launch-kit-session");
    });

    it("redacts secret values from CLI-native extracted responses", async () => {
      vi.stubEnv("SMITHERSBOT_GATEWAY_TOKEN", "FAKE_NATIVE_SECRET_789");
      runCliProcessMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Do not leak FAKE_NATIVE_SECRET_789" }],
          },
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 45,
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "redact native response",
        workingDir: "/repo",
      });

      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("FAKE_NATIVE_SECRET_789");
    });

    it("regression: redacts fake secret values from Codex output-last-message content", async () => {
      vi.stubEnv("SMITHERSBOT_GATEWAY_TOKEN", "FAKE_OUTPUT_LAST_SECRET_123");
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(
          LAST_MESSAGE_FILE_PATH,
          "The answer must hide FAKE_OUTPUT_LAST_SECRET_123\n",
          "utf-8",
        );
        return {
          stdout: '{"type":"thread.started","thread_id":"codex-redact-last"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 46,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "redact output-last-message response",
        workingDir: "/repo",
      });

      expect(result.text).toContain("[REDACTED]");
      expect(result.text).not.toContain("FAKE_OUTPUT_LAST_SECRET_123");
      expect(result.cliSessionId).toBe("codex-redact-last");
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
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Recovered response" }],
            },
          }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 55,
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
      // Repair must preserve the MCP isolation flags so the repair invocation also
      // stays isolated from the user's global MCP/plugin set.
      expect(repairCall.args).toContain("--strict-mcp-config");
      expect(repairCall.args).toContain("--mcp-config");
      const repairMcpIdx = repairCall.args.indexOf("--mcp-config");
      expect(repairCall.args[repairMcpIdx + 1]).toBe(EMPTY_MCP_CONFIG_PATH);
      // The --resume <sessionId> pair is spliced in before the prompt, after the MCP flags.
      const repairResumeIdx = repairCall.args.indexOf("--resume");
      expect(repairResumeIdx).toBeGreaterThan(repairMcpIdx);
      expect(repairCall.args[repairResumeIdx + 1]).toBe("claude-session-repair");
      // The `--` end-of-options separator must come after --resume and before the prompt
      // so claude's variadic --mcp-config doesn't swallow the repair prompt either.
      const repairSepIdx = repairCall.args.indexOf("--");
      expect(repairSepIdx).toBeGreaterThan(repairResumeIdx);
      expect(repairSepIdx).toBe(repairCall.args.length - 2);
      expect(repairCall.args.at(-1)).toContain(
        "Reply now with the complete answer as your final assistant message.",
      );
      expect(repairCall.args.at(-1)).toContain("Do not write files.");
      expect(repairCall.args.at(-1)).not.toContain("cat <<");
      expect(result.text).toBe("Recovered response");
    });

    it("regression: sandbox-safe repair returns a final assistant message without file writes", async () => {
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: '{"session_id":"claude-safe-repair"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 48,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Safe repair answer" }],
            },
            session_id: "claude-safe-repair",
          }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 58,
        });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "repair without response file write",
        workingDir: "/repo",
      });

      const repairCall = runCliProcessMock.mock.calls[1]?.[0] as { args: string[] };
      expect(repairCall.args.at(-1)).toContain("Do not write files.");
      expect(repairCall.args.at(-1)).toContain("Do not use shell redirects.");
      expect(repairCall.args.at(-1)).not.toContain("cat <<");
      expect(result.text).toBe("Safe repair answer");
      expect(result.cliSessionId).toBe("claude-safe-repair");
    });

    it("preserves MCP isolation invariants on Claude repair path with a multi-KB RESPONSE FILE prompt", async () => {
      const userQuestion =
        "Explain how cli-worker.ts dispatches Claude versus Codex backends.\n".repeat(150);
      runCliProcessMock
        .mockResolvedValueOnce({
          stdout: '{"session_id":"claude-session-big"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 50,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Repaired big response" }],
            },
          }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 60,
        });

      await runRepoChatWorker({
        backend: "claude_code",
        prompt: userQuestion,
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(2);
      const initialCall = runCliProcessMock.mock.calls[0]?.[0] as { args: string[] };
      const repairCall = runCliProcessMock.mock.calls[1]?.[0] as { args: string[] };

      // The initial call's prompt starts with final-message preamble and is multi-KB.
      const initialPrompt = initialCall.args.at(-1) ?? "";
      expect(initialPrompt).toContain("FINAL RESPONSE (CRITICAL - READ THIS CAREFULLY):");
      expect(initialPrompt).not.toContain("cat <<");
      expect(initialPrompt.length).toBeGreaterThan(4_000);

      for (const call of [initialCall, repairCall]) {
        // (1) --strict-mcp-config present.
        expect(call.args).toContain("--strict-mcp-config");
        // (2) --mcp-config present as exact element.
        expect(call.args).toContain("--mcp-config");
        const mcpIdx = call.args.indexOf("--mcp-config");
        // (3) Path immediately follows --mcp-config and is non-empty.
        const mcpValue = call.args[mcpIdx + 1];
        expect(typeof mcpValue).toBe("string");
        expect(mcpValue).toBe(EMPTY_MCP_CONFIG_PATH);
        // (4) Empty MCP config file exists and is exactly {mcpServers:{}}.
        const raw = fs.readFileSync(EMPTY_MCP_CONFIG_PATH, "utf-8");
        expect(JSON.parse(raw)).toEqual({ mcpServers: {} });
        // (5) Prompt is the FINAL positional arg.
        const prompt = call.args.at(-1) ?? "";
        expect(prompt.length).toBeGreaterThan(0);
        // (6) Prompt is NEVER the value of --mcp-config.
        expect(mcpValue).not.toBe(prompt);
        // `--` separator sits immediately before the trailing prompt.
        expect(call.args.at(-2)).toBe("--");
      }

      // Repair path must include --resume <sessionId> between --mcp-config and --.
      const resumeIdx = repairCall.args.indexOf("--resume");
      const repairMcpIdx = repairCall.args.indexOf("--mcp-config");
      const repairSepIdx = repairCall.args.indexOf("--");
      expect(repairMcpIdx).toBeLessThan(resumeIdx);
      expect(resumeIdx).toBeLessThan(repairSepIdx);
      expect(repairCall.args[resumeIdx + 1]).toBe("claude-session-big");
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
        .mockResolvedValueOnce({
          stdout:
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Recovered from empty file"}]}}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 26,
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
      expect(repairCall.args).toContain("--json");
      expect(repairCall.args.at(-1)).toContain(
        "Reply now with the complete answer as your final assistant message.",
      );
      expect(repairCall.args.at(-1)).not.toContain("cat <<");
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
        .mockResolvedValueOnce({
          stdout:
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Recovered with preserved session"}]}}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 26,
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

    it("extracts codex response from stdout when output-last-message is empty", async () => {
      const stdout = [
        '{"type":"thread","session_id":"codex-session-stdout","thread_id":"codex-thread-stdout"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working through repo details"}]}}',
        '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Final answer from codex stdout"}]}}',
      ].join("\n");
      expect(extractResponseFromCodexStdout(stdout)).toBe("Final answer from codex stdout");
      runCliProcessMock.mockResolvedValueOnce({
        stdout,
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 27,
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "Explain repo stdout fallback",
        workingDir: "/repo",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        args: string[];
      };
      expect(call.args).toContain("--output-last-message");
      expect(call.args).toContain(LAST_MESSAGE_FILE_PATH);
      expect(call.args).not.toContain(RESPONSE_FILE_PATH);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CONTEXT);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CODEX_STYLE_PROMPT);
      expect(result.text).toBe("Final answer from codex stdout");
      expect(result.cliSessionId).toBe("codex-thread-stdout");
    });

    it("regression: returns Codex --output-last-message content before legacy response files", async () => {
      runCliProcessMock.mockImplementationOnce(async () => {
        fs.writeFileSync(LAST_MESSAGE_FILE_PATH, "Codex final answer from output-last-message\n");
        fs.writeFileSync(RESPONSE_FILE_PATH, "legacy response file should not win\n");
        return {
          stdout: '{"type":"thread.started","thread_id":"codex-last-message-regression"}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 29,
        };
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "prefer output-last-message content",
        workingDir: "/repo",
      });

      const call = runCliProcessMock.mock.calls[0]?.[0] as { args: string[] };
      expect(call.args).toContain("--output-last-message");
      expect(call.args).toContain(LAST_MESSAGE_FILE_PATH);
      expect(result.text).toBe("Codex final answer from output-last-message");
      expect(result.cliSessionId).toBe("codex-last-message-regression");
    });

    it("regression: repo-chat invocation keeps repository mutation disabled", async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-chat-readonly-"));
      const repoFile = path.join(repoDir, "README.md");
      fs.writeFileSync(repoFile, "original\n", "utf-8");
      runCliProcessMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I can inspect this repository but cannot edit it." }],
          },
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 30,
      });

      try {
        const result = await runRepoChatWorker({
          backend: "codex",
          prompt: "Please append a line to README.md",
          workingDir: repoDir,
        });

        const call = runCliProcessMock.mock.calls[0]?.[0] as { args: string[]; cwd: string };
        expect(call.cwd).toBe(repoDir);
        expect(call.args).toContain("--sandbox");
        expect(call.args).toContain("read-only");
        expect(call.args).not.toContain("workspace-write");
        expect(fs.readFileSync(repoFile, "utf-8")).toBe("original\n");
        expect(result.text).toContain("cannot edit");
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("repo-chat worker uses agent root for managed workspaces and refuses private env cwd", async () => {
      const originalManagedRoot = process.env.SMITHERSBOT_GOALS_ROOT;
      const managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-chat-managed-run-"));
      process.env.SMITHERSBOT_GOALS_ROOT = managedRoot;
      try {
        const agentRoot = path.join(managedRoot, "agent");
        const repoDir = path.join(agentRoot, "workspaces", "smithersbot", "repo");
        const historyDir = path.join(agentRoot, "history", "repo-chats", "smithersbot");
        const privateEnvDir = path.join(managedRoot, "private", "env", "smithersbot");
        fs.mkdirSync(repoDir, { recursive: true });
        fs.mkdirSync(historyDir, { recursive: true });
        fs.mkdirSync(privateEnvDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, "README.md"), "managed repo\n", "utf8");
        fs.writeFileSync(path.join(historyDir, "summary.json"), '{"safe":true}\n', "utf8");

        runCliProcessMock.mockResolvedValueOnce({
          stdout: JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Read managed repo and sanitized history." }],
            },
          }),
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 31,
        });

        const result = await runRepoChatWorker({
          backend: "codex",
          prompt: "Read README and history.",
          workingDir: repoDir,
        });

        const call = runCliProcessMock.mock.calls[0]?.[0] as { args: string[]; cwd: string };
        const cdIdx = call.args.indexOf("--cd");
        expect(call.cwd).toBe(agentRoot);
        expect(call.args[cdIdx + 1]).toBe(agentRoot);
        expect(fs.existsSync(path.join(call.cwd, "history", "repo-chats", "smithersbot"))).toBe(
          true,
        );
        expect(path.relative(call.cwd, privateEnvDir).startsWith("..")).toBe(true);
        expect(result.text).toContain("sanitized history");

        await expect(
          runRepoChatWorker({
            backend: "codex",
            prompt: "Read private env.",
            workingDir: privateEnvDir,
          }),
        ).rejects.toThrow(/private paths/);

        const privateSymlink = path.join(repoDir, "private-env-link");
        fs.symlinkSync(privateEnvDir, privateSymlink, "dir");
        await expect(
          runRepoChatWorker({
            backend: "codex",
            prompt: "Read private env through a symlink.",
            workingDir: privateSymlink,
          }),
        ).rejects.toThrow(/private paths/);
      } finally {
        if (originalManagedRoot === undefined) delete process.env.SMITHERSBOT_GOALS_ROOT;
        else process.env.SMITHERSBOT_GOALS_ROOT = originalManagedRoot;
        fs.rmSync(managedRoot, { recursive: true, force: true });
      }
    });

    it("regression: returns backend refusal text as the repo-chat response", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I can’t help modify repository files from repo chat, but I can explain the relevant code.",
              },
            ],
          },
          session_id: "claude-refusal-session",
        }),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 31,
      });

      const result = await runRepoChatWorker({
        backend: "claude_code",
        prompt: "Write a new file in the repository",
        workingDir: "/repo",
      });

      expect(result.text).toContain("can’t help modify repository files");
      expect(result.cliSessionId).toBe("claude-refusal-session");
    });

    it("extracts codex response from stdout for resumed sessions", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: [
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working"}]}}',
          '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Resumed final answer from codex stdout"}]}}',
        ].join("\n"),
        stderr: "",
        timedOut: false,
        exitCode: 0,
        signal: null,
        durationMs: 28,
      });

      const result = await runRepoChatWorker({
        backend: "codex",
        prompt: "Explain resumed repo stdout fallback",
        workingDir: "/repo",
        cliSessionId: "codex-resume-thread",
      });

      expect(runCliProcessMock).toHaveBeenCalledTimes(1);
      const call = runCliProcessMock.mock.calls[0]?.[0] as {
        args: string[];
      };
      expect(call.args).not.toContain("--output-last-message");
      expect(call.args).not.toContain(RESPONSE_FILE_PATH);
      expect(call.args).not.toContain(LAST_MESSAGE_FILE_PATH);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CONTEXT);
      expect(call.args.at(-1)).toContain(REPO_CHAT_CODEX_STYLE_PROMPT);
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
        .mockResolvedValueOnce({
          stdout:
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Recovered repo answer"}]}}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 31,
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
        .mockResolvedValueOnce({
          stdout:
            '{"type":"result","is_error":false,"result":{"content":[{"type":"text","text":"Recovered after missing manual file"}]}}',
          stderr: "",
          timedOut: false,
          exitCode: 0,
          signal: null,
          durationMs: 37,
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
        "Repo chat worker completed without a deliverable response after CLI extraction, legacy response-file check, and sandbox-safe repair. (placeholder stdout reply rejected)",
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
        "Repo chat worker completed without a deliverable response after CLI extraction, legacy response-file check, and sandbox-safe repair. (placeholder stdout reply rejected)",
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
        "Repo chat worker completed without a deliverable response after CLI extraction, legacy response-file check, and sandbox-safe repair.",
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

    it("includes exit, signal, and durationMs tokens in the thrown message", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "boom",
        timedOut: false,
        exitCode: 7,
        signal: "SIGTERM",
        durationMs: 137,
      });

      let caught: unknown;
      try {
        await runRepoChatWorker({
          backend: "claude_code",
          prompt: "meta token check",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      const message = (caught as Error | undefined)?.message ?? "";
      expect(message).toContain("exit=7");
      expect(message).toContain("signal=SIGTERM");
      expect(message).toContain("durationMs=137");
      // When signal is null, the token should still be present as 'signal=none'.
    });

    it("uses 'signal=none' when signal is null", async () => {
      runCliProcessMock.mockResolvedValueOnce({
        stdout: "",
        stderr: "no signal",
        timedOut: false,
        exitCode: 2,
        signal: null,
        durationMs: 5,
      });

      let caught: unknown;
      try {
        await runRepoChatWorker({
          backend: "claude_code",
          prompt: "null signal token",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      expect((caught as Error | undefined)?.message ?? "").toContain("signal=none");
    });

    it("prefers tail of stdout when stderr is empty and stdout is long", async () => {
      const head = "EARLIEST_OUTPUT_START " + "h".repeat(50);
      // Need stdout longer than MAX_ERROR_DETAIL_CHARS (8 KB) so tail truncation kicks in
      // and the head section is dropped from the surfaced detail.
      const middle = "x".repeat(15_000);
      const tailMarker = "y".repeat(50) + " TAIL_END_MARKER";
      const longStdout = `${head}\n${middle}\n${tailMarker}`;

      runCliProcessMock.mockResolvedValueOnce({
        stdout: longStdout,
        stderr: "",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 42,
      });

      let caught: unknown;
      try {
        await runRepoChatWorker({
          backend: "claude_code",
          prompt: "tail of stdout",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      const message = (caught as Error | undefined)?.message ?? "";
      expect(message).toContain("TAIL_END_MARKER");
      expect(message).not.toContain("EARLIEST_OUTPUT_START");
      expect(message).toContain("exit=1");
      expect(message).toContain("durationMs=42");
    });

    it("appends the MCP startup hint when stderr is empty and stdout is only an init event", async () => {
      const initEvent = JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["Read", "Glob", "Grep", "Bash"],
        model: "claude-opus-4-7",
        mcp_servers: ["gmail", "calendar", "drive"],
      });

      runCliProcessMock.mockResolvedValueOnce({
        stdout: initEvent,
        stderr: "",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 8,
      });

      let caught: unknown;
      try {
        await runRepoChatWorker({
          backend: "claude_code",
          prompt: "mcp startup hint",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      const message = (caught as Error | undefined)?.message ?? "";
      expect(message).toContain(
        "Claude Code exited during startup, possibly MCP/plugin initialization. Repo chat runs with strict empty MCP config; if this still happens, run claude --debug to inspect startup.",
      );
      expect(message).toContain("exit=1");
      expect(message).toContain("signal=none");
      expect(message).toContain("durationMs=8");
    });

    it("does not append the MCP startup hint when stdout contains an assistant or result event", async () => {
      const stdout = [
        JSON.stringify({ type: "system", subtype: "init", tools: [] }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
      ].join("\n");

      runCliProcessMock.mockResolvedValueOnce({
        stdout,
        stderr: "",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 13,
      });

      let caught: unknown;
      try {
        await runRepoChatWorker({
          backend: "claude_code",
          prompt: "hint should not appear",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      const message = (caught as Error | undefined)?.message ?? "";
      expect(message).not.toContain(
        "Claude Code exited during startup, possibly MCP/plugin initialization.",
      );
    });

    it("truncates oversized stderr to keep the error message bounded", async () => {
      const oversizedStderr = "z".repeat(20_000);

      runCliProcessMock.mockResolvedValueOnce({
        stdout: "",
        stderr: oversizedStderr,
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 4,
      });

      let caught: unknown;
      try {
        await runRepoChatWorker({
          backend: "claude_code",
          prompt: "truncation cap",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      const message = (caught as Error | undefined)?.message ?? "";
      // The detail body itself must be capped at 8 KB plus the ellipsis suffix.
      expect(message).toContain("z".repeat(100));
      expect(message).not.toContain("z".repeat(20_000));
      expect(message).toContain("...");
      // Whole message stays well under 2x the cap (header + meta + truncated body).
      expect(message.length).toBeLessThan(9_500);
      expect(message).toContain("exit=1");
    });

    it("truncates oversized stdout tail to keep the error message bounded", async () => {
      const oversizedStdout = "q".repeat(20_000);

      runCliProcessMock.mockResolvedValueOnce({
        stdout: oversizedStdout,
        stderr: "",
        timedOut: false,
        exitCode: 1,
        signal: null,
        durationMs: 6,
      });

      let caught: unknown;
      try {
        await runRepoChatWorker({
          backend: "claude_code",
          prompt: "stdout tail truncation cap",
          workingDir: "/repo",
        });
      } catch (err) {
        caught = err;
      }

      const message = (caught as Error | undefined)?.message ?? "";
      expect(message).toContain("q".repeat(100));
      expect(message).not.toContain("q".repeat(20_000));
      // Tail truncation prefixes the detail body with an ellipsis.
      expect(message).toContain("...q");
      expect(message.length).toBeLessThan(9_500);
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
