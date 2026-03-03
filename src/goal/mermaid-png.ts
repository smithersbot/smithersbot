import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { warn } from "../globals.js";

// Use userInfo().homedir (reads from /etc/passwd) instead of homedir() which
// follows $HOME — tests override HOME to a temp dir, breaking puppeteer's
// Chrome lookup.
const PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR ?? path.join(userInfo().homedir, ".cache", "puppeteer");

export const DEFAULT_MERMAID_RENDER_TIMEOUT_MS = 600_000;

export type MermaidRenderResult = { buffer: Buffer } | { error: string } | null;

/** Transparent background so the PNG blends with any chat theme. */
export const MERMAID_PNG_BACKGROUND = "transparent";

/** mmdc config: fontFamily must be set here (init directives don't propagate in mmdc v11). */
const MERMAID_CONFIG = {
  theme: "dark",
  fontFamily:
    "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Noto Sans, DejaVu Sans, Liberation Sans, Arial, sans-serif",
  flowchart: { curve: "basis", nodeSpacing: 28, rankSpacing: 44 },
};

/**
 * Render a Mermaid diagram to a PNG buffer using the `mmdc` CLI.
 *
 * Returns `null` on timeout so the caller can fall back to text.
 */
export function renderMermaidToPng(mermaidText: string): MermaidRenderResult {
  if (process.env.MOLTBOT_DEBUG_MERMAID === "1") {
    const lines = mermaidText.split("\n").slice(0, 80);
    warn("mermaid-png: DEBUG mermaid source (first 80 lines):\n" + lines.join("\n"));
  }

  let tempDir: string | undefined;
  try {
    const configuredTimeout = Number.parseInt(
      process.env.MOLTBOT_MERMAID_RENDER_TIMEOUT_MS ?? "",
      10,
    );
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_MERMAID_RENDER_TIMEOUT_MS;

    tempDir = mkdtempSync(path.join(tmpdir(), "mermaid-png-"));
    const inputPath = path.join(tempDir, "input.mmd");
    const outputPath = path.join(tempDir, "output.png");
    const configPath = path.join(tempDir, "mermaid-config.json");
    writeFileSync(inputPath, mermaidText);
    writeFileSync(configPath, JSON.stringify(MERMAID_CONFIG));

    // Resolve mmdc from project node_modules
    const mmdcPath = path.resolve(import.meta.dirname ?? __dirname, "../../node_modules/.bin/mmdc");

    execFileSync(
      mmdcPath,
      [
        "-i",
        inputPath,
        "-o",
        outputPath,
        "-b",
        MERMAID_PNG_BACKGROUND,
        "-s",
        "3",
        "--quiet",
        "-c",
        configPath,
      ],
      {
        timeout: timeoutMs,
        stdio: "pipe",
        env: { ...process.env, PUPPETEER_CACHE_DIR },
      },
    );

    return { buffer: readFileSync(outputPath) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`mermaid-png: render failed: ${msg}`);
    if (/chrome/i.test(msg) || /puppeteer/i.test(msg)) {
      warn("Hint: run `pnpm install` and ensure puppeteer is in .npmrc allow-build-scripts.");
    }
    const timeoutSignal =
      typeof err === "object" && err !== null ? (err as { signal?: string }).signal : undefined;
    const timeoutKilled =
      typeof err === "object" && err !== null
        ? (err as { killed?: boolean }).killed === true
        : false;
    if (timeoutKilled || timeoutSignal === "SIGTERM") {
      return null;
    }
    return { error: msg };
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function extractMermaidFromResponse(response: string): string {
  const fencedMermaid = response.match(/```mermaid\s*([\s\S]*?)```/i);
  if (fencedMermaid?.[1]) {
    return fencedMermaid[1].trim();
  }

  const fencedCode = response.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  if (fencedCode?.[1]) {
    return fencedCode[1].trim();
  }

  return response.trim();
}

export async function repairMermaidDiagram(opts: {
  source: string;
  error: string;
  askFn: (prompt: string) => Promise<string>;
}): Promise<Buffer | null> {
  const { source, error, askFn } = opts;

  try {
    const repairPrompt = [
      "The Mermaid diagram below failed to render with mmdc.",
      "Fix node IDs, labels, and Mermaid syntax while preserving the same DAG structure and intent.",
      "Return only the corrected Mermaid diagram in a single ```mermaid``` fenced code block.",
      "",
      "Original Mermaid:",
      "```mermaid",
      source.trim(),
      "```",
      "",
      "mmdc error:",
      "```text",
      error.trim(),
      "```",
    ].join("\n");

    const response = await askFn(repairPrompt);
    const repairedSource = extractMermaidFromResponse(response);
    if (!repairedSource) {
      return null;
    }

    const renderResult = renderMermaidToPng(repairedSource);
    if (renderResult && "buffer" in renderResult) {
      return renderResult.buffer;
    }
    return null;
  } catch {
    return null;
  }
}
