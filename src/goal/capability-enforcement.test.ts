import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import {
  createEnforcedBashOperations,
  createEnforcedCodingTools,
} from "./capability-enforcement.js";
import { HARD_DENIES, checkCommandDeny, checkPathDeny } from "./hard-deny.js";

const WORKING_DIR = "/home/user/project";

afterEach(() => {
  vi.restoreAllMocks();
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createCodingTools: () => [
    { name: "Read", execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) },
    { name: "Write", execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) },
    { name: "Edit", execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) },
  ],
}));

/** Mock BashOperations that records calls. */
function mockBashOps(): BashOperations & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(command, _cwd, options) {
      calls.push(command);
      options.onData(Buffer.from("ok\n"));
      return { exitCode: 0 };
    },
  };
}

function createEnoentError(): NodeJS.ErrnoException {
  const error = new Error("ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

describe("hard deny helpers", () => {
  it("checkPathDeny blocks .env files", () => {
    const deny = checkPathDeny("/home/user/project/.env.local");
    expect(deny).not.toBeNull();
  });

  it("checkPathDeny allows normal source files", () => {
    const deny = checkPathDeny("/home/user/project/src/index.ts");
    expect(deny).toBeNull();
  });

  it("checkCommandDeny blocks sudo", () => {
    const deny = checkCommandDeny("sudo rm -rf /");
    expect(deny).not.toBeNull();
  });

  it("checkCommandDeny allows pnpm test", () => {
    const deny = checkCommandDeny("pnpm test");
    expect(deny).toBeNull();
  });

  it("checkCommandDeny blocks gateway service restart commands", () => {
    const direct = checkCommandDeny("systemctl --user restart moltbot-gateway-dev.service");
    const absolute = checkCommandDeny(
      "/usr/bin/systemctl --user restart moltbot-gateway-dev.service",
    );
    const cli = checkCommandDeny("moltbot gateway restart");
    expect(direct).not.toBeNull();
    expect(absolute).not.toBeNull();
    expect(cli).not.toBeNull();
  });
});

describe("createEnforcedBashOperations", () => {
  it("denies hard-denied commands and returns a message", async () => {
    const denied: string[] = [];
    const mock = mockBashOps();
    const ops = createEnforcedBashOperations(HARD_DENIES, (d) => denied.push(d.reason), mock);
    const output: string[] = [];
    const result = await ops.exec("sudo apt-get install vim", WORKING_DIR, {
      onData: (data) => output.push(data.toString()),
    });

    expect(result.exitCode).toBe(126);
    expect(denied.length).toBe(1);
    expect(output.join("")).toContain("Denied:");
  });
});

describe("createEnforcedCodingTools", () => {
  it("denies Read on hard-denied paths", async () => {
    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const readTool = tools.find((t) => t.name === "Read");
    expect(readTool).toBeTruthy();

    const result = await readTool!.execute("1", { path: ".env" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Denied:");
  });

  it("denies path access when realpath resolves to a denied target", async () => {
    vi.spyOn(fs, "realpathSync").mockReturnValue("/home/user/.ssh/id_rsa");

    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const readTool = tools.find((t) => t.name === "Read");
    expect(readTool).toBeTruthy();

    const result = await readTool!.execute("1", { path: "data/file.txt" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Denied:");
    expect(fs.realpathSync).toHaveBeenCalledWith(path.resolve(WORKING_DIR, "data/file.txt"));
  });

  it("still denies direct denied paths when realpath matches the original path", async () => {
    vi.spyOn(fs, "realpathSync").mockReturnValue(path.resolve(WORKING_DIR, ".env"));

    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const readTool = tools.find((t) => t.name === "Read");
    expect(readTool).toBeTruthy();

    const result = await readTool!.execute("1", { path: ".env" });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("Denied:");
  });

  it("falls back to resolved path checks when realpathSync returns ENOENT", async () => {
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw createEnoentError();
    });

    const tools = createEnforcedCodingTools(WORKING_DIR, HARD_DENIES);
    const writeTool = tools.find((t) => t.name === "Write");
    expect(writeTool).toBeTruthy();

    const result = await writeTool!.execute("1", {
      path: "notes/new-file.txt",
      content: "hello",
    });
    const text = result.content?.[0]?.text ?? "";
    expect(text).toBe("ok");
    expect(fs.realpathSync).toHaveBeenCalledWith(path.resolve(WORKING_DIR, "notes/new-file.txt"));
  });
});
