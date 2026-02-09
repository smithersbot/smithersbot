import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

const SIGTERM_GRACE_MS = 5_000;

export type RunCliProcessParams = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  stdin?: string;
  stdoutPath?: string;
  stderrPath?: string;
};

export type RunCliProcessResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcess(proc: ChildProcess): void {
  if (!proc.pid) return;
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (!proc.pid) return;
    if (isProcessAlive(proc.pid)) {
      proc.kill("SIGKILL");
    }
  }, SIGTERM_GRACE_MS);
}

export async function runCliProcess(params: RunCliProcessParams): Promise<RunCliProcessResult> {
  const { command, args, cwd, timeoutMs, abortSignal, stdin, stdoutPath, stderrPath } = params;
  const start = Date.now();

  if (abortSignal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      timedOut: true,
      exitCode: null,
      signal: null,
      durationMs: 0,
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let stdoutStream: fs.WriteStream | undefined;
    let stderrStream: fs.WriteStream | undefined;

    if (stdoutPath) {
      try {
        stdoutStream = fs.createWriteStream(stdoutPath, { flags: "w" });
      } catch {
        stdoutStream = undefined;
      }
    }
    if (stderrPath) {
      try {
        stderrStream = fs.createWriteStream(stderrPath, { flags: "w" });
      } catch {
        stderrStream = undefined;
      }
    }

    const proc: ChildProcess = spawn(command, args, {
      cwd,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (stdin && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (stdoutStream) stdoutStream.write(chunk);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (stderrStream) stderrStream.write(chunk);
    });

    const hardTimeout = setTimeout(() => {
      if (timedOut) return;
      timedOut = true;
      terminateProcess(proc);
    }, timeoutMs);

    const abortHandler = () => {
      if (timedOut) return;
      timedOut = true;
      terminateProcess(proc);
    };
    if (abortSignal) {
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (abortSignal) {
        abortSignal.removeEventListener("abort", abortHandler);
      }
      stdoutStream?.end();
      stderrStream?.end();
      if (timedOut && proc.pid && isProcessAlive(proc.pid)) {
        proc.kill("SIGKILL");
      }
      resolve({
        stdout,
        stderr,
        timedOut,
        exitCode,
        signal,
        durationMs: Date.now() - start,
      });
    };

    proc.on("close", (code, signal) => {
      finish(code, signal);
    });

    proc.on("error", (err) => {
      stderr += `\nProcess error: ${err.message}`;
      finish(1, null);
    });
  });
}
