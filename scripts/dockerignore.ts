/**
 * Docker ignore-file matching with Docker's ordered, last-match semantics. The
 * Docker release planner and the build-context secret policy share it.
 */
import { isAbsolute, posix, win32 } from "node:path";

/** A context-relative path in POSIX form; refuses absolute paths and paths outside the context. */
export function normalizeCandidatePath(path: string): string {
  if (path.includes("\0")) throw new Error("unsafe Docker context path contains NUL");
  const platformPath = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  if (isAbsolute(platformPath) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)) {
    throw new Error(`unsafe absolute Docker context path: ${path}`);
  }
  const normalized = posix.normalize(platformPath.replace(/^\.\/+/, ""));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe Docker context path outside the repository: ${path}`);
  }
  return normalized;
}

function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function escapeClassCharacter(character: string): string {
  return /[-\\\]^]/.test(character) ? `\\${character}` : character;
}

function classCharacter(pattern: string, index: number): { character: string; nextIndex: number } {
  const character = pattern[index];
  if (!character || character === "]" || character === "-") {
    throw new Error(`invalid Docker ignore pattern: ${pattern}`);
  }
  if (character !== "\\") return { character, nextIndex: index + 1 };
  const escaped = pattern[index + 1];
  if (!escaped) throw new Error(`invalid Docker ignore pattern: ${pattern}`);
  return { character: escaped, nextIndex: index + 2 };
}

function characterClassSource(pattern: string, start: number): { end: number; source: string } {
  let index = start + 1;
  let negated = false;
  if (pattern[index] === "^") {
    negated = true;
    index += 1;
  }
  let body = "";
  let rangeCount = 0;
  while (index < pattern.length && pattern[index] !== "]") {
    const low = classCharacter(pattern, index);
    index = low.nextIndex;
    if (pattern[index] === "-" && pattern[index + 1] !== "]") {
      const high = classCharacter(pattern, index + 1);
      const lowPoint = low.character.codePointAt(0);
      const highPoint = high.character.codePointAt(0);
      if (lowPoint === undefined || highPoint === undefined || lowPoint > highPoint) {
        throw new Error(`invalid Docker ignore pattern: ${pattern}`);
      }
      body += `${escapeClassCharacter(low.character)}-${escapeClassCharacter(high.character)}`;
      index = high.nextIndex;
    } else {
      body += escapeClassCharacter(low.character);
    }
    rangeCount += 1;
  }
  if (rangeCount === 0 || pattern[index] !== "]") {
    throw new Error(`invalid Docker ignore pattern: ${pattern}`);
  }
  return { end: index, source: `[${negated ? "^" : ""}${body}]` };
}

function dockerGlobRegex(pattern: string): RegExp | undefined {
  if (pattern === "" || pattern === ".") return undefined;

  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "\\") {
      const next = pattern[index + 1];
      if (next === undefined) throw new Error(`invalid Docker ignore pattern: ${pattern}`);
      source += escapeRegexCharacter(next);
      index += 1;
    } else if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const characterClass = characterClassSource(pattern, index);
      source += characterClass.source;
      index = characterClass.end;
    } else if (character === "]") {
      throw new Error(`invalid Docker ignore pattern: ${pattern}`);
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  source += "$";
  try {
    return new RegExp(source, "u");
  } catch {
    throw new Error(`invalid Docker ignore pattern: ${pattern}`);
  }
}

interface ParsedIgnoreRule {
  excluded: boolean;
  matcher: RegExp;
}

function cleanDockerPattern(pattern: string): string {
  let cleaned =
    process.platform === "win32"
      ? win32.normalize(pattern).replaceAll("\\", "/")
      : posix.normalize(pattern);
  if (cleaned.length > 1) cleaned = cleaned.replace(/\/+$/, "");
  return cleaned.length > 1 && cleaned.startsWith("/") ? cleaned.slice(1) : cleaned;
}

function parseIgnoreRule(rawRule: string, firstRule = false): ParsedIgnoreRule | undefined {
  let rule = firstRule ? rawRule.replace(/^\uFEFF/, "") : rawRule;
  if (rule.startsWith("#")) return undefined;
  rule = rule.trim();
  if (rule === "") return undefined;
  let initiallyNegated = false;
  if (rule.startsWith("!")) {
    initiallyNegated = true;
    rule = rule.slice(1).trim();
  }
  if (rule) rule = cleanDockerPattern(rule);
  if (initiallyNegated) rule = `!${rule}`;

  let excluded = true;
  if (rule.startsWith("!")) {
    if (rule.length === 1) throw new Error('invalid Docker ignore pattern: "!"');
    excluded = false;
    rule = rule.slice(1);
  }
  const matcher = dockerGlobRegex(rule);
  return matcher ? { excluded, matcher } : undefined;
}

/** Docker-compatible ordered, last-match ignore evaluation for a path name. */
export function createDockerIgnoreMatcher(rules: readonly string[]): (path: string) => boolean {
  const parsed = rules
    .map((rawRule, index) => parseIgnoreRule(rawRule, index === 0))
    .filter((rule): rule is ParsedIgnoreRule => rule !== undefined);
  return (path: string) => {
    const normalizedPath = normalizeCandidatePath(path);
    const segments = normalizedPath.split("/");
    const candidates = [
      normalizedPath,
      ...segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/")),
    ];
    let excluded = false;
    for (const rule of parsed) {
      if (rule && candidates.some((candidate) => rule.matcher.test(candidate))) {
        excluded = rule.excluded;
      }
    }
    return excluded;
  };
}

export function dockerIgnoreExcludes(path: string, rules: readonly string[]): boolean {
  return createDockerIgnoreMatcher(rules)(path);
}
