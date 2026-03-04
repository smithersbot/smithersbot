export function collapseWhitespace(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

export function truncateSummary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const keep = Math.max(0, maxChars - 3);
  return `${value.slice(0, keep).trimEnd()}...`;
}

export function parseShortSummary(raw: unknown, fallback: unknown, maxChars: number): string {
  const normalized = collapseWhitespace(raw);
  if (normalized.length > 0) {
    return truncateSummary(normalized, maxChars);
  }
  return truncateSummary(collapseWhitespace(fallback), maxChars);
}
