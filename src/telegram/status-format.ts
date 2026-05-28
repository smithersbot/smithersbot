export type StatusMessageOptions = {
  title: string;
  lines: readonly string[];
};

export function boldLabel(label: string, value: string): string {
  return `**${label.trim()}:** ${value.trim()}`;
}

export function collapseBlankLines(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatStatusMessage({ title, lines }: StatusMessageOptions): string {
  return collapseBlankLines(
    [`**${title.trim()}**`, ...lines.map((line) => line.trim())].join("\n"),
  );
}
