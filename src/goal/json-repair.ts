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

  return text;
}
