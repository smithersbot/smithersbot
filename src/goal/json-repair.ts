function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function canParseJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function stripTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (!char) continue;

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let lookahead = i + 1;
      while (isWhitespace(text[lookahead])) {
        lookahead += 1;
      }
      const next = text[lookahead];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    output += char;
  }

  return output;
}

function stripOrphanClosingBrackets(text: string): string {
  const openStack: string[] = [];
  let output = "";
  let inString = false;
  let escaping = false;
  let changed = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (!char) continue;

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === "{" || char === "[") {
      openStack.push(char);
      output += char;
      continue;
    }

    if (char === "}" || char === "]") {
      const expectedOpen = char === "}" ? "{" : "[";
      const top = openStack.at(-1);
      if (!top) {
        changed = true;
        continue;
      }
      if (top === expectedOpen) {
        openStack.pop();
        output += char;
        continue;
      }
    }

    output += char;
  }

  // Do not try to recover missing closing delimiters or unterminated strings.
  if (inString || openStack.length > 0) return text;
  return changed ? output : text;
}

type OpenBracket = {
  char: "{" | "[";
  index: number;
};

type JsonScanState = {
  escaping: boolean;
  inString: boolean;
  openStack: OpenBracket[];
};

function scanJsonStructure(text: string): JsonScanState {
  const openStack: OpenBracket[] = [];
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (!char) continue;

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      openStack.push({ char, index: i });
      continue;
    }

    if (char === "}" || char === "]") {
      const expectedOpen = char === "}" ? "{" : "[";
      const top = openStack.at(-1);
      if (top?.char === expectedOpen) openStack.pop();
    }
  }

  return { escaping, inString, openStack };
}

function isLikelyIncompleteTail(text: string, forced: boolean): boolean {
  if (forced) return true;

  const trimmed = text.trimEnd();
  if (!trimmed) return false;

  const lastChar = trimmed.at(-1);
  if (!lastChar) return false;

  if (lastChar === ":" || lastChar === "," || lastChar === "{" || lastChar === "[") return true;
  if (lastChar === "." || lastChar === "-" || lastChar === "+") return true;

  const trailingWord = trimmed.match(/[A-Za-z]+$/)?.[0];
  if (
    trailingWord &&
    trailingWord !== "true" &&
    trailingWord !== "false" &&
    trailingWord !== "null"
  ) {
    return true;
  }

  return false;
}

function findTruncationTrimIndex(text: string, openStack: OpenBracket[]): number | null {
  const target = openStack.at(-1);
  if (!target) return null;

  let inString = false;
  let escaping = false;
  let nestedDepth = 0;
  let lastComma = -1;

  for (let i = target.index + 1; i < text.length; i += 1) {
    const char = text[i];
    if (!char) continue;

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      nestedDepth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      if (nestedDepth > 0) nestedDepth -= 1;
      continue;
    }

    if (char === "," && nestedDepth === 0) lastComma = i;
  }

  if (lastComma >= 0) return lastComma;
  if (openStack.length === 1) return target.index + 1;

  let lookbehind = target.index - 1;
  while (isWhitespace(text[lookbehind])) lookbehind -= 1;
  const previous = lookbehind >= 0 ? text[lookbehind] : undefined;
  if (previous === ":" || previous === "," || previous === "[") return target.index;
  return target.index + 1;
}

export function repairTruncatedJson(text: string): string {
  if (!text.trim()) return text;
  if (canParseJson(text)) return text;

  let repaired = text;
  let forceTrim = false;
  const initialScan = scanJsonStructure(repaired);
  if (initialScan.inString) {
    if (initialScan.escaping) repaired += "\\";
    repaired += '"';
    forceTrim = true;
  }

  let iterations = 0;
  while (iterations < 32) {
    const scan = scanJsonStructure(repaired);
    const shouldTrim = scan.openStack.length > 0 && isLikelyIncompleteTail(repaired, forceTrim);
    forceTrim = false;
    if (!shouldTrim) break;

    const trimIndex = findTruncationTrimIndex(repaired, scan.openStack);
    if (trimIndex === null) break;

    const next = repaired.slice(0, trimIndex).trimEnd();
    if (next === repaired) break;

    repaired = next;
    iterations += 1;
  }

  const finalScan = scanJsonStructure(repaired);
  if (finalScan.inString) {
    if (finalScan.escaping) repaired += "\\";
    repaired += '"';
  }

  const balancedScan = scanJsonStructure(repaired);
  for (let i = balancedScan.openStack.length - 1; i >= 0; i -= 1) {
    const open = balancedScan.openStack[i];
    if (!open) continue;
    repaired += open.char === "{" ? "}" : "]";
  }

  return stripTrailingCommas(repaired);
}

function extractCodeFenceCandidates(text: string): string[] {
  const candidates: string[] = [];
  const codeFence = /```(?:[A-Za-z0-9_-]+)?\s*([\s\S]*?)```/g;
  for (const match of text.matchAll(codeFence)) {
    const candidate = match[1]?.trim();
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function collectRepairCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  add(text);

  const fenceCandidates = extractCodeFenceCandidates(text);
  for (const candidate of fenceCandidates) add(candidate);

  for (const candidate of extractJsonObjectCandidates(text)) add(candidate);
  for (const candidate of fenceCandidates) {
    for (const nestedCandidate of extractJsonObjectCandidates(candidate)) {
      add(nestedCandidate);
    }
  }

  return candidates;
}

function attemptShallowRepair(text: string): string {
  const withoutTrailingCommas = stripTrailingCommas(text);
  const withoutOrphanClosers = stripOrphanClosingBrackets(withoutTrailingCommas);

  if (canParseJson(withoutOrphanClosers)) return withoutOrphanClosers;

  const alternateOrder = stripTrailingCommas(stripOrphanClosingBrackets(text));
  if (canParseJson(alternateOrder)) return alternateOrder;

  return text;
}

export function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!ch) continue;

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

export function repairJsonText(text: string): string {
  if (!text.trim()) return text;
  if (canParseJson(text)) return text;

  const candidates = collectRepairCandidates(text);
  for (const candidate of candidates) {
    if (canParseJson(candidate)) return candidate;
    const repaired = attemptShallowRepair(candidate);
    if (canParseJson(repaired)) return repaired;
  }

  for (const candidate of candidates) {
    const repaired = repairTruncatedJson(candidate);
    if (canParseJson(repaired)) return repaired;
  }

  return text;
}
