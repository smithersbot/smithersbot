import { describe, expect, it, vi } from "vitest";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import {
  createEnforcedBashOperations,
  createEnforcedCodingTools,
} from "./capability-enforcement.js";
import { HARD_DENIES, checkCommandDeny, checkPathDeny } from "./hard-deny.js";

const WORKING_DIR = "/home/user/project";

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
});
