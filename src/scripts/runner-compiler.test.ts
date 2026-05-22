import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type CompilerResolution =
  | {
      compiler: string;
      explicit: boolean;
      ok: true;
      resolvedPath: string | null;
    }
  | {
      compiler: string;
      explicit: boolean;
      message: string;
      ok: false;
    };

type CompilerModule = {
  resolveTypeScriptCompiler(params: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }): CompilerResolution;
};

const tempRoots: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testTmpRoot = path.join(repoRoot, ".tmp", "runner-compiler-tests");
const compilerModulePath = path.join(repoRoot, "scripts", "ts-compiler.mjs");

const loadCompilerModule = async () =>
  (await import(pathToFileURL(compilerModulePath).href)) as CompilerModule;

const createExecutable = (filePath: string, body = "#!/bin/sh\nexit 0\n") => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
};

const createWorkspace = () => {
  fs.mkdirSync(testTmpRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testTmpRoot, "workspace-"));
  tempRoots.push(root);
  return root;
};

const resolveCompiler = async ({
  env = {},
  localCompilers = [],
  pathCompilers = [],
}: {
  env?: Record<string, string>;
  localCompilers?: string[];
  pathCompilers?: string[];
}) => {
  const compilerModule = await loadCompilerModule();
  const workspace = createWorkspace();
  const localBin = path.join(workspace, "node_modules", ".bin");
  const pathBin = path.join(workspace, "fake-path-bin");

  for (const compiler of localCompilers) {
    createExecutable(path.join(localBin, compiler));
  }
  for (const compiler of pathCompilers) {
    createExecutable(path.join(pathBin, compiler));
  }

  return compilerModule.resolveTypeScriptCompiler({
    cwd: workspace,
    env: {
      PATH: pathBin,
      ...env,
    },
  });
};

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("runner TypeScript compiler resolution", () => {
  it("is used by both runner entrypoints", () => {
    const runNode = fs.readFileSync(path.join(repoRoot, "scripts", "run-node.mjs"), "utf8");
    const watchNode = fs.readFileSync(path.join(repoRoot, "scripts", "watch-node.mjs"), "utf8");

    expect(runNode).toContain('from "./ts-compiler.mjs"');
    expect(runNode).toContain("resolveTypeScriptCompiler");
    expect(watchNode).toContain('from "./ts-compiler.mjs"');
    expect(watchNode).toContain("resolveTypeScriptCompiler");
  });

  it("falls back to tsc when implicit tsgo is missing", async () => {
    const result = await resolveCompiler({ localCompilers: ["tsc"] });

    expect(result).toMatchObject({
      compiler: "tsc",
      explicit: false,
      ok: true,
    });
  });

  it("prefers implicit tsgo when tsgo resolves", async () => {
    const result = await resolveCompiler({ localCompilers: ["tsc", "tsgo"] });

    expect(result).toMatchObject({
      compiler: "tsgo",
      explicit: false,
      ok: true,
    });
  });

  it("honors explicit CLAWDBOT_TS_COMPILER=tsc", async () => {
    const result = await resolveCompiler({
      env: { CLAWDBOT_TS_COMPILER: "tsc" },
      localCompilers: ["tsc", "tsgo"],
    });

    expect(result).toMatchObject({
      compiler: "tsc",
      explicit: true,
      ok: true,
    });
  });

  it("honors explicit CLAWDBOT_TS_COMPILER=tsgo when tsgo resolves from PATH", async () => {
    const result = await resolveCompiler({
      env: { CLAWDBOT_TS_COMPILER: "tsgo" },
      localCompilers: ["tsc"],
      pathCompilers: ["tsgo"],
    });

    expect(result).toMatchObject({
      compiler: "tsgo",
      explicit: true,
      ok: true,
    });
  });

  it("does not crash implicit resolution when tsgo is missing and tsc is available", async () => {
    const result = await resolveCompiler({ localCompilers: ["tsc"] });

    expect(result.ok).toBe(true);
    expect(result.compiler).toBe("tsc");
  });

  it("fails clearly when an explicit compiler is unavailable", async () => {
    const result = await resolveCompiler({
      env: { CLAWDBOT_TS_COMPILER: "tsgo" },
      localCompilers: ["tsc"],
    });

    expect(result).toMatchObject({
      compiler: "tsgo",
      explicit: true,
      ok: false,
    });
    if (result.ok) {
      throw new Error("expected explicit tsgo to fail when unavailable");
    }
    expect(result.message).toContain('TypeScript compiler "tsgo"');
    expect(result.message).toContain("CLAWDBOT_TS_COMPILER");
    expect(result.message).toContain("not found in node_modules/.bin or PATH");
  });
});
