import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownLinkSpan,
  type MarkdownIR,
} from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";
import type { MarkdownTableMode } from "../config/types.base.js";

export type TelegramFormattedChunk = {
  html: string;
  text: string;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function buildTelegramLink(link: MarkdownLinkSpan, _text: string) {
  const href = link.href.trim();
  if (!href) return null;
  if (link.start === link.end) return null;
  const safeHref = escapeHtmlAttr(href);
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${safeHref}">`,
    close: "</a>",
  };
}

function renderTelegramHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: "<pre><code>", close: "</code></pre>" },
    },
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
  });
}

/**
 * Collapse blank-line-heavy output into single newlines. Used by opt-in
 * callers (e.g. the Goal Brief send path) that want compact sections without
 * the paragraph-separator blank lines markdownToIR emits between blocks.
 */
function compactBlankLines(value: string): string {
  return value.replace(/\n{2,}/g, "\n");
}

export type TelegramRenderOptions = {
  tableMode?: MarkdownTableMode;
  /**
   * How to render markdown headings. Defaults to "none" (headings rendered as
   * plain text) so existing callers are unchanged. "bold" wraps heading text in
   * <b> for Telegram.
   */
  headingStyle?: "none" | "bold";
  /** Collapse runs of blank lines into a single newline. Default false. */
  compact?: boolean;
};

export function markdownToTelegramHtml(
  markdown: string,
  options: TelegramRenderOptions = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: options.headingStyle ?? "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  const html = renderTelegramHtml(ir);
  return options.compact ? compactBlankLines(html) : html;
}

export function renderTelegramHtmlText(
  text: string,
  options: { textMode?: "markdown" | "html"; tableMode?: MarkdownTableMode } = {},
): string {
  const textMode = options.textMode ?? "markdown";
  if (textMode === "html") return text;
  return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}

export function markdownToTelegramChunks(
  markdown: string,
  limit: number,
  options: TelegramRenderOptions = {},
): TelegramFormattedChunk[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: options.headingStyle ?? "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => {
    const html = renderTelegramHtml(chunk);
    return {
      html: options.compact ? compactBlankLines(html) : html,
      text: options.compact ? compactBlankLines(chunk.text) : chunk.text,
    };
  });
}

export function markdownToTelegramHtmlChunks(markdown: string, limit: number): string[] {
  return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}
