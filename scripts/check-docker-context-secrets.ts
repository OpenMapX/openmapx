/**
 * Root Docker build-context policy. Candidate files are enumerated by name
 * through Git; this script never opens or prints their contents.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_DOCKERIGNORE_RULES = [
  "infra/docker/secrets/",
  "**/.generated-secrets/",
  "**/*.key",
  "**/*.jks",
  "**/*.keystore",
  "**/*.p12",
  "**/*.mobileprovision",
  "**/*.ipa",
  "**/*.aab",
  "**/*.apk",
  "apps/mobile/ios/",
  "apps/mobile/android/",
  "apps/mobile/.expo/",
  "apps/mobile/.gradle/",
] as const;

const RETAINED_SECRET_RULES = [".env*", "**/.env*", "!.env.example", "*.pem", "**/*.pem"] as const;
const ALL_REQUIRED_RULES = [...REQUIRED_DOCKERIGNORE_RULES, ...RETAINED_SECRET_RULES] as const;
const SENSITIVE_EXTENSION_RE = /\.(?:key|jks|keystore|p12|mobileprovision|ipa|aab|apk|pem)$/i;
const SENSITIVE_NAME_PREFIX_RE = /^(?:secrets?|credentials?)/i;

function normalizedRuleLines(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function normalizeCandidatePath(path: string): string {
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
export function dockerIgnoreExcludes(path: string, rules: readonly string[]): boolean {
  const normalizedPath = normalizeCandidatePath(path);
  const segments = normalizedPath.split("/");
  const candidates = [
    normalizedPath,
    ...segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/")),
  ];
  let excluded = false;
  for (const [index, rawRule] of rules.entries()) {
    const rule = parseIgnoreRule(rawRule, index === 0);
    if (rule && candidates.some((candidate) => rule.matcher.test(candidate))) {
      excluded = rule.excluded;
    }
  }
  return excluded;
}

function sensitiveCandidate(path: string): boolean {
  const normalized = normalizeCandidatePath(path);
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? normalized;
  return (
    normalized.startsWith("infra/docker/secrets/") ||
    segments.includes(".generated-secrets") ||
    normalized.startsWith("apps/mobile/ios/") ||
    normalized.startsWith("apps/mobile/android/") ||
    normalized.startsWith("apps/mobile/.expo/") ||
    normalized.startsWith("apps/mobile/.gradle/") ||
    basename.toLowerCase().startsWith(".env") ||
    SENSITIVE_EXTENSION_RE.test(basename) ||
    SENSITIVE_NAME_PREFIX_RE.test(basename)
  );
}

// Asking Git for every ignored file can be enormous after a production build
// (for example, Next's standalone tree contains a second node_modules). Restrict
// enumeration to the same name classes sensitiveCandidate() evaluates. Fixed
// sensitive directories remain recursive so a later Docker-ignore negation is
// still detected.
const SENSITIVE_IGNORED_PATHSPECS = [
  ":(glob,icase)**/.env*",
  ":(glob,icase)**/*.key",
  ":(glob,icase)**/*.jks",
  ":(glob,icase)**/*.keystore",
  ":(glob,icase)**/*.p12",
  ":(glob,icase)**/*.mobileprovision",
  ":(glob,icase)**/*.ipa",
  ":(glob,icase)**/*.aab",
  ":(glob,icase)**/*.apk",
  ":(glob,icase)**/*.pem",
  ":(glob,icase)**/secret*",
  ":(glob,icase)**/credential*",
  ":(glob)infra/docker/secrets/**",
  ":(glob)**/.generated-secrets/**",
  ":(glob)apps/mobile/ios/**",
  ":(glob)apps/mobile/android/**",
  ":(glob)apps/mobile/.expo/**",
  ":(glob)apps/mobile/.gradle/**",
] as const;

export function enumerateSensitiveIgnoredPathNames(rootDir: string): string[] {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ...SENSITIVE_IGNORED_PATHSPECS,
    ],
    { cwd: rootDir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return output.split("\0").filter(Boolean);
}

function yamlScalar(rawValue: string): string {
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return value;
}

function isExpression(value: string): boolean {
  return value.includes("${{") || /(^|[^\\])(?:\$|`)/.test(value);
}

type ContextKind = "root" | "other" | "ambiguous" | "unsafe";

function contextKind(value: string): ContextKind {
  if (isExpression(value)) return "ambiguous";
  try {
    const normalized = normalizeCandidatePath(value);
    return normalized === "." ? "root" : "other";
  } catch {
    return "unsafe";
  }
}

function safeDockerfilePath(value: string): { error?: string; path?: string } {
  if (isExpression(value)) return { error: `ambiguous Dockerfile path: ${value}` };
  try {
    const normalized = normalizeCandidatePath(value);
    if (normalized === ".") return { error: `unsafe Dockerfile path: ${value}` };
    return { path: normalized };
  } catch {
    return { error: `unsafe Dockerfile path: ${value}` };
  }
}

interface DiscoveryResult {
  dockerfiles: Set<string>;
  errors: string[];
}

function addRootBuild(
  discovery: DiscoveryResult,
  context: string,
  dockerfile: string | undefined,
  source: string,
): void {
  const kind = contextKind(context);
  if (kind === "ambiguous" || kind === "unsafe") {
    discovery.errors.push(`${source} has an ${kind} Docker build context: ${context}`);
    return;
  }
  if (kind !== "root") return;
  const resolved = safeDockerfilePath(dockerfile ?? "Dockerfile");
  if (resolved.error) discovery.errors.push(`${source} has an ${resolved.error}`);
  else if (resolved.path) discovery.dockerfiles.add(resolved.path);
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = (): void => {
    if (token) tokens.push(token);
    token = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    const candidateExpansion = quote === "'" ? undefined : shellExpansionSpan(command, index);
    const expansion =
      candidateExpansion && shellExpansionIsExecutable(candidateExpansion, quote, false)
        ? candidateExpansion
        : undefined;
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote === "'") {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (expansion) {
      token += command.slice(index, expansion.end + 1);
      index = expansion.end;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      flush();
    } else if (character === "(" || character === ")") {
      flush();
      tokens.push(character);
    } else if (character === ";" || character === "|") {
      flush();
      break;
    } else {
      token += character;
    }
  }
  flush();
  return tokens;
}

const DOCKER_BOOLEAN_BUILD_OPTIONS = new Set([
  "--check",
  "--compress",
  "--disable-content-trust",
  "--force-rm",
  "--load",
  "--no-cache",
  "--pull",
  "--provenance",
  "--push",
  "--quiet",
  "--rm",
  "--sbom",
  "--squash",
  "-q",
]);

const DOCKER_VALUE_BUILD_OPTIONS = new Set([
  "--add-host",
  "--allow",
  "--annotation",
  "--attest",
  "--build-arg",
  "--build-context",
  "--builder",
  "--cache-from",
  "--cache-to",
  "--call",
  "--cgroup-parent",
  "--cpu-period",
  "--cpu-quota",
  "--cpu-shares",
  "--cpuset-cpus",
  "--cpuset-mems",
  "--file",
  "--iidfile",
  "--isolation",
  "--label",
  "--memory",
  "--memory-swap",
  "--network",
  "--no-cache-filter",
  "--output",
  "--platform",
  "--progress",
  "--secret",
  "--security-opt",
  "--shm-size",
  "--ssh",
  "--tag",
  "--target",
  "--ulimit",
  "-f",
  "-m",
  "-o",
  "-t",
]);

interface ShellBuildResult {
  builds: Array<{ context: string; dockerfile?: string }>;
  errors: string[];
}

const SHELL_CONTROL_PREFIXES = new Set([
  "!",
  "(",
  "{",
  "do",
  "elif",
  "if",
  "then",
  "until",
  "while",
]);
const SHELL_DYNAMIC_EXECUTABLES = new Set(["eval"]);
const SHELL_INTERPRETERS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const ENV_BOOLEAN_OPTIONS = new Set(["-0", "-i", "--ignore-environment", "--null"]);
const ENV_DYNAMIC_OPTIONS = new Set(["-S", "--split-string"]);
const ENV_VALUE_OPTIONS = new Set(["-C", "--chdir", "-u", "--unset"]);

interface ShellExecutable {
  end: number;
  error?: string;
  executable?: string;
  externalCommand?: boolean;
  index?: number;
  replacesShell?: boolean;
}

function staticShellExecutableName(token: string): string {
  return token.startsWith("/") ? posix.basename(token) : token;
}

function resolvedShellExecutable(tokens: readonly string[]): ShellExecutable {
  let end = tokens.length;
  while (tokens[end - 1] === ")") end -= 1;
  let index = 0;
  let externalCommand = false;
  let replacesShell = false;
  while (SHELL_CONTROL_PREFIXES.has(tokens[index] ?? "")) index += 1;

  const skipAssignments = (): void => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
  };
  skipAssignments();

  while (index < end) {
    const wrapperToken = tokens[index] ?? "";
    const wrapper = staticShellExecutableName(wrapperToken);
    if (wrapper === "env") {
      externalCommand = true;
      index += 1;
      let optionsEnded = false;
      while (index < end) {
        const token = tokens[index] ?? "";
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
          index += 1;
        } else if (!optionsEnded && token === "--") {
          optionsEnded = true;
          index += 1;
        } else if (!optionsEnded && ENV_BOOLEAN_OPTIONS.has(token)) {
          index += 1;
        } else if (
          !optionsEnded &&
          (ENV_DYNAMIC_OPTIONS.has(token) ||
            [...ENV_DYNAMIC_OPTIONS].some((option) => token.startsWith(`${option}=`)))
        ) {
          return { end, error: `unsupported dynamic env wrapper option: ${token}` };
        } else if (!optionsEnded && ENV_VALUE_OPTIONS.has(token)) {
          if (!tokens[index + 1]) {
            return { end, error: `unsupported or ambiguous env wrapper option: ${token}` };
          }
          index += 2;
        } else if (
          !optionsEnded &&
          [...ENV_VALUE_OPTIONS].some((option) => token.startsWith(`${option}=`))
        ) {
          index += 1;
        } else if (!optionsEnded && token.startsWith("-")) {
          return { end, error: `unsupported or ambiguous env wrapper option: ${token}` };
        } else {
          break;
        }
      }
      break;
    }
    if (wrapper === "command") {
      index += 1;
      if (tokens[index] === "-v" || tokens[index] === "-V") return { end };
      while (tokens[index] === "--" || tokens[index] === "-p") index += 1;
      if ((tokens[index] ?? "").startsWith("-")) {
        return { end, error: `unsupported or ambiguous command wrapper option: ${tokens[index]}` };
      }
      continue;
    }
    if (wrapper === "builtin") {
      index += 1;
      while (tokens[index] === "--" || tokens[index] === "-a" || tokens[index] === "-p") {
        index += 1;
      }
      const target = tokens[index];
      if (!target) return { end };
      if ((target ?? "").startsWith("-")) {
        return { end, error: `unsupported or ambiguous builtin wrapper option: ${target}` };
      }
      if (!["builtin", "command", "eval", "exec"].includes(staticShellExecutableName(target))) {
        return { end };
      }
      continue;
    }
    if (wrapper === "exec") {
      replacesShell = true;
      index += 1;
      let optionsEnded = false;
      while (index < end) {
        const token = tokens[index] ?? "";
        if (!optionsEnded && token === "--") {
          optionsEnded = true;
          index += 1;
        } else if (!optionsEnded && (token === "-c" || token === "-l")) {
          index += 1;
        } else if (!optionsEnded && token === "-a") {
          if (!tokens[index + 1]) {
            return { end, error: "unsupported or ambiguous exec wrapper option: -a" };
          }
          index += 2;
        } else if (!optionsEnded && token.startsWith("-")) {
          return { end, error: `unsupported or ambiguous exec wrapper option: ${token}` };
        } else {
          break;
        }
      }
      continue;
    }
    break;
  }

  skipAssignments();
  const executableToken = tokens[index];
  if (!executableToken || index >= end) {
    return replacesShell ? { end, error: "unsupported exec without a static executable" } : { end };
  }
  if (isExpression(executableToken)) {
    return { end, error: `ambiguous dynamic shell executable: ${executableToken}` };
  }
  const executable = staticShellExecutableName(executableToken);
  if (SHELL_DYNAMIC_EXECUTABLES.has(executable)) {
    return { end, error: `unsupported dynamic shell command: ${executable}` };
  }
  if (
    SHELL_INTERPRETERS.has(executable) &&
    tokens.slice(index + 1, end).some((token) => token === "-c" || /^-[^-]*c/.test(token))
  ) {
    return { end, error: `unsupported dynamic shell command: ${executable} -c` };
  }
  return { end, executable, externalCommand, index, replacesShell };
}

type ShellTerminator =
  | "and"
  | "background"
  | "case-break"
  | "case-fallthrough"
  | "case-retest"
  | "end"
  | "or"
  | "pipe"
  | "sequence";

interface ShellEvent {
  command: string;
  expansionCommands: ShellExpansionCommand[];
  terminator: ShellTerminator;
}

interface ShellExpansionCommand {
  legacyBacktickBody: boolean;
  legacyDelimiterOwnership: boolean;
  source: string;
}

type ShellListTerminator = Exclude<
  ShellTerminator,
  "case-break" | "case-fallthrough" | "case-retest"
>;

interface ShellCommandNode {
  command: string;
  expansionPrograms?: ShellProgram[];
  kind: "command";
  terminator: ShellListTerminator;
}

interface ShellCaseArm {
  catchAll: boolean;
  nodes: ShellNode[];
  pattern: string;
  terminator: "break" | "fallthrough" | "retest";
}

interface ShellCaseNode {
  arms: ShellCaseArm[];
  expansionPrograms?: ShellProgram[];
  kind: "case";
  terminator: ShellListTerminator;
}

interface ShellGroupNode {
  expansionPrograms?: ShellProgram[];
  kind: "group";
  nodes: ShellNode[];
  redirection?: string;
  subshell: boolean;
  terminator: ShellListTerminator;
}

type ShellNode = ShellCaseNode | ShellCommandNode | ShellGroupNode;

interface ShellProgram {
  errors: string[];
  expandingHereDocument: boolean;
  expansionCommands: ShellExpansionCommand[];
  nodes: ShellNode[];
}

const MAX_SHELL_EXPANSION_DEPTH = 16;
const MAX_SHELL_EXPANSION_NODES = 256;

interface StaticHereDocument {
  delimiter: string;
  end: number;
  expands: boolean;
  stripTabs: boolean;
}

const SHELL_HERE_DOCUMENT_EXPANSION_MARKER = "\u0000openmapx-here-expansion:";

function staticHereDocument(line: string): { error?: string; value?: StaticHereDocument } {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let found: StaticHereDocument | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) break;
    if (
      character !== "<" ||
      line[index + 1] !== "<" ||
      line[index - 1] === "<" ||
      line[index + 2] === "<"
    ) {
      continue;
    }
    if (found) return { error: "unsupported multiple shell here-documents on one command" };
    let cursor = index + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor += 1;
    while (/\s/.test(line[cursor] ?? "")) cursor += 1;
    const delimiterQuote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : undefined;
    if (delimiterQuote) cursor += 1;
    const start = cursor;
    while (/[A-Za-z0-9_]/.test(line[cursor] ?? "")) cursor += 1;
    const delimiter = line.slice(start, cursor);
    if (!delimiter || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(delimiter)) {
      return { error: "unsupported dynamic shell here-document delimiter" };
    }
    if (delimiterQuote) {
      if (line[cursor] !== delimiterQuote) {
        return { error: "unterminated shell here-document delimiter quote" };
      }
      cursor += 1;
    }
    found = { delimiter, end: cursor, expands: delimiterQuote === undefined, stripTabs };
    index = cursor - 1;
  }
  return { value: found };
}

function stripStaticHereDocumentBodies(source: string): {
  errors: string[];
  expandingBodies: string[];
  source: string;
} {
  const errors: string[] = [];
  const expandingBodies: string[] = [];
  const lines = source.split(/\r?\n/);
  const retained: string[] = [];
  let active: StaticHereDocument | undefined;
  let activeBody: string[] = [];
  let activeBodyIndex: number | undefined;
  for (const line of lines) {
    if (active) {
      const candidate = active.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === active.delimiter) {
        if (activeBodyIndex !== undefined) {
          expandingBodies[activeBodyIndex] = activeBody.join("\n");
        }
        active = undefined;
        activeBody = [];
        activeBodyIndex = undefined;
      } else if (active.expands) {
        activeBody.push(line);
      }
      retained.push("");
      continue;
    }
    const parsed = staticHereDocument(line);
    if (parsed.error) errors.push(parsed.error);
    active = parsed.value;
    if (active?.expands) {
      activeBodyIndex = expandingBodies.length;
      expandingBodies.push("");
      retained.push(
        `${line.slice(0, active.end)}${SHELL_HERE_DOCUMENT_EXPANSION_MARKER}${activeBodyIndex}\u0000${line.slice(active.end)}`,
      );
    } else {
      retained.push(line);
    }
  }
  if (active) errors.push(`unterminated shell here-document: ${active.delimiter}`);
  return { errors, expandingBodies, source: retained.join("\n") };
}

interface ShellExpansionSpan {
  command?: ShellExpansionCommand;
  end: number;
  error?: string;
  kind: "backtick" | "command" | "process";
}

function consumeLegacyBacktickLayer(source: string): string {
  let consumed = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\\") {
      consumed += source[index] ?? "";
      continue;
    }
    let cursor = index;
    while (source[cursor] === "\\") cursor += 1;
    const backslashes = cursor - index;
    const pairedBackslashes = Math.floor(backslashes / 2);
    if (cursor >= source.length) {
      if (pairedBackslashes > 0) consumed += `'${"\\".repeat(pairedBackslashes)}'`;
      if (backslashes % 2 === 1) consumed += "\\";
      break;
    }
    consumed += "\\".repeat(pairedBackslashes);
    if (backslashes % 2 === 0) {
      index = cursor - 1;
      continue;
    }
    const next = source[cursor];
    if (next === "$" || next === "`") {
      consumed += next;
      index = cursor;
      continue;
    }
    if (next === "\n") {
      index = cursor;
      continue;
    }
    if (next === "\r" && source[cursor + 1] === "\n") {
      index = cursor + 1;
      continue;
    }
    consumed += "\\";
    index = cursor - 1;
  }
  return consumed;
}

function consumeShellLineContinuations(source: string): string {
  return source.replace(/\\+(?:\r\n|\n)/g, (continuation) => {
    const newlineLength = continuation.endsWith("\r\n") ? 2 : 1;
    const backslashes = continuation.length - newlineLength;
    if (backslashes % 2 === 0) return continuation;
    return "\\".repeat(backslashes - 1);
  });
}

function shellExpansionSpan(
  source: string,
  start: number,
  legacyDelimiterOwnership = false,
): ShellExpansionSpan | undefined {
  const opener = source[start] ?? "";
  if (opener === "`") {
    let escaped = false;
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const current = source[cursor] ?? "";
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === "`") {
        let commandSource = source.slice(start + 1, cursor);
        if (legacyDelimiterOwnership) {
          let escapeStart = cursor;
          while (source[escapeStart - 1] === "\\") escapeStart -= 1;
          const delimiterEscapes = cursor - escapeStart;
          const retainedLiteralEscapes = Math.floor(delimiterEscapes / 4);
          commandSource =
            source.slice(start + 1, escapeStart) +
            (retainedLiteralEscapes > 0 ? `'${"\\".repeat(retainedLiteralEscapes)}'` : "");
        }
        return {
          command: {
            legacyBacktickBody: true,
            legacyDelimiterOwnership: false,
            source: commandSource,
          },
          end: cursor,
          kind: "backtick",
        };
      }
    }
    return {
      end: source.length - 1,
      error: "unterminated shell backtick command substitution",
      kind: "backtick",
    };
  }

  const substitution =
    (opener === "$" && source[start + 1] === "(") ||
    ((opener === "<" || opener === ">") && source[start + 1] === "(");
  if (!substitution) return undefined;
  if (opener === "$" && source[start + 2] === "(") {
    return {
      end: start + 2,
      error: "unsupported arithmetic shell expansion",
      kind: "command",
    };
  }

  let depth = 1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let cursor = start + 2; cursor < source.length; cursor += 1) {
    const current = source[cursor] ?? "";
    if (escaped) {
      escaped = false;
    } else if (current === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (current === quote) quote = undefined;
    } else if (current === "'" || current === '"') {
      quote = current;
    } else if (current === "`") {
      const backtick = shellExpansionSpan(source, cursor);
      if (backtick?.error) return backtick;
      if (backtick) cursor = backtick.end;
    } else if (
      current === "#" &&
      (cursor === start + 2 || /[\s;|&()]/.test(source[cursor - 1] ?? ""))
    ) {
      while (cursor + 1 < source.length && source[cursor + 1] !== "\n") cursor += 1;
    } else if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          command: {
            legacyBacktickBody: false,
            legacyDelimiterOwnership,
            source: source.slice(start + 2, cursor),
          },
          end: cursor,
          kind: opener === "$" ? "command" : "process",
        };
      }
    }
  }
  return {
    end: source.length - 1,
    error: "unterminated shell command or process substitution",
    kind: opener === "$" ? "command" : "process",
  };
}

function shellExpansionIsExecutable(
  expansion: ShellExpansionSpan,
  quote: "'" | '"' | undefined,
  hereDocumentBody: boolean,
): boolean {
  if (expansion.kind !== "process") return quote !== "'";
  return quote === undefined && !hereDocumentBody;
}

function shellExpansionCommands(
  source: string,
  hereDocumentBody = false,
  legacyDelimiterOwnership = false,
): { commands: ShellExpansionCommand[]; errors: string[] } {
  const commands: ShellExpansionCommand[] = [];
  const errors: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (!hereDocumentBody && quote === "'") {
      if (character === quote) quote = undefined;
      continue;
    }
    if (!hereDocumentBody && character === "'" && quote === undefined) {
      quote = character;
      continue;
    }
    if (!hereDocumentBody && character === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (
      !hereDocumentBody &&
      character === "#" &&
      (index === 0 || /[\s;|&()]/.test(source[index - 1] ?? ""))
    ) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    const candidateExpansion =
      quote === "'" ? undefined : shellExpansionSpan(source, index, legacyDelimiterOwnership);
    const expansion =
      candidateExpansion && shellExpansionIsExecutable(candidateExpansion, quote, hereDocumentBody)
        ? candidateExpansion
        : undefined;
    if (!expansion) continue;
    if (expansion.error) errors.push(expansion.error);
    if (expansion.command !== undefined) commands.push(expansion.command);
    index = expansion.end;
  }
  return { commands, errors };
}

function shellCommandEvents(
  source: string,
  legacyDelimiterOwnership = false,
): {
  errors: string[];
  events: ShellEvent[];
  expandingHereDocument: boolean;
  expansionCommands: ShellExpansionCommand[];
} {
  const hereDocuments = stripStaticHereDocumentBodies(source);
  const logicalSource = consumeShellLineContinuations(hereDocuments.source);
  const errors: string[] = [...hereDocuments.errors];
  const expansionResults = [
    shellExpansionCommands(logicalSource, false, legacyDelimiterOwnership),
    ...hereDocuments.expandingBodies.map((body) =>
      shellExpansionCommands(body, true, legacyDelimiterOwnership),
    ),
  ];
  const expansions = {
    commands: expansionResults.flatMap((result) => result.commands),
    errors: expansionResults.flatMap((result) => result.errors),
  };
  errors.push(...expansions.errors);
  const events: ShellEvent[] = [];
  let command = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = (terminator: ShellTerminator, preserveEmpty = false): void => {
    const hereDocumentCommands: ShellExpansionCommand[] = [];
    let withoutHereDocumentMarkers = command;
    let markerStart = withoutHereDocumentMarkers.indexOf(SHELL_HERE_DOCUMENT_EXPANSION_MARKER);
    while (markerStart >= 0) {
      const bodyIndexStart = markerStart + SHELL_HERE_DOCUMENT_EXPANSION_MARKER.length;
      const markerEnd = withoutHereDocumentMarkers.indexOf("\u0000", bodyIndexStart);
      if (markerEnd < 0) break;
      const bodyIndex = Number(withoutHereDocumentMarkers.slice(bodyIndexStart, markerEnd));
      hereDocumentCommands.push(...(expansionResults[bodyIndex + 1]?.commands ?? []));
      withoutHereDocumentMarkers =
        withoutHereDocumentMarkers.slice(0, markerStart) +
        withoutHereDocumentMarkers.slice(markerEnd + 1);
      markerStart = withoutHereDocumentMarkers.indexOf(SHELL_HERE_DOCUMENT_EXPANSION_MARKER);
    }
    const normalized = withoutHereDocumentMarkers.trim();
    if (normalized || preserveEmpty) {
      events.push({
        command: normalized,
        expansionCommands: [
          ...shellExpansionCommands(normalized, false, legacyDelimiterOwnership).commands,
          ...hereDocumentCommands,
        ],
        terminator,
      });
    }
    command = "";
  };
  for (let index = 0; index < logicalSource.length; index += 1) {
    const character = logicalSource[index] ?? "";
    if (escaped) {
      if (
        quote === undefined &&
        ((character === "$" && logicalSource[index + 1] === "(") ||
          (character === "(" && command.endsWith("$\\")))
      ) {
        errors.push("unsupported escaped shell expansion opener");
      }
      command += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      command += character;
      escaped = true;
      continue;
    }
    if (quote === "'") {
      command += character;
      if (character === quote) quote = undefined;
      continue;
    }
    const candidateExpansion = shellExpansionSpan(logicalSource, index);
    const expansion =
      candidateExpansion && shellExpansionIsExecutable(candidateExpansion, quote, false)
        ? candidateExpansion
        : undefined;
    if (expansion) {
      if (expansion.error) errors.push(expansion.error);
      command += logicalSource.slice(index, expansion.end + 1);
      index = expansion.end;
      continue;
    }
    if (quote) {
      command += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      command += character;
      quote = character;
      continue;
    }
    if (character === "#" && (command === "" || /\s$/.test(command))) {
      while (index + 1 < logicalSource.length && logicalSource[index + 1] !== "\n") index += 1;
      continue;
    }
    const next = logicalSource[index + 1];
    const following = logicalSource[index + 2];
    if (character === ";" && next === ";" && following === "&") {
      flush("case-retest", true);
      index += 2;
    } else if (character === ";" && next === "&") {
      flush("case-fallthrough", true);
      index += 1;
    } else if (character === ";" && next === ";") {
      flush("case-break", true);
      index += 1;
    } else if (character === ";") {
      flush("sequence");
    } else if (
      character === "&" &&
      (next === ">" || command.endsWith(">") || command.endsWith("<"))
    ) {
      command += character;
    } else if (character === "&" && next === "&") {
      flush("and");
      index += 1;
    } else if (character === "&") {
      flush("background");
    } else if (character === "|" && next === "|") {
      flush("or");
      index += 1;
    } else if (character === "|") {
      flush("pipe");
    } else if (character === "\n") {
      flush("sequence");
    } else {
      command += character;
    }
  }
  if (quote) errors.push("unterminated shell quote");
  if (escaped) errors.push("unterminated shell escape");
  flush("end");
  return {
    errors,
    events,
    expandingHereDocument: hereDocuments.expandingBodies.length > 0,
    expansionCommands: expansions.commands,
  };
}

interface ShellWordSpan {
  end: number;
  start: number;
  value: string;
}

function shellWordSpans(source: string): ShellWordSpan[] {
  const words: ShellWordSpan[] = [];
  let start: number | undefined;
  let value = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = (end: number): void => {
    if (start !== undefined) words.push({ end, start, value });
    start = undefined;
    value = "";
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const candidateExpansion = quote === "'" ? undefined : shellExpansionSpan(source, index);
    const expansion =
      candidateExpansion && shellExpansionIsExecutable(candidateExpansion, quote, false)
        ? candidateExpansion
        : undefined;
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      if (start === undefined) start = index;
      escaped = true;
    } else if (quote === "'") {
      if (character === quote) quote = undefined;
      else value += character;
    } else if (expansion) {
      if (start === undefined) start = index;
      value += source.slice(index, expansion.end + 1);
      index = expansion.end;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else value += character;
    } else if (character === "'" || character === '"') {
      if (start === undefined) start = index;
      quote = character;
    } else if (/\s/.test(character)) {
      flush(index);
    } else {
      if (start === undefined) start = index;
      value += character;
    }
  }
  flush(source.length);
  return words;
}

function caseHeaderRemainder(command: string): string | undefined {
  const words = shellWordSpans(command);
  if (words[0]?.value !== "case") return undefined;
  const inWord = words.slice(2).find((word) => word.value === "in");
  if (!inWord) throw new Error("unsupported or ambiguous case header");
  return command.slice(inWord.end).trim();
}

function casePattern(command: string): { pattern: string; remainder: string } | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ")") {
      const pattern = command
        .slice(0, index)
        .trim()
        .replace(/^\(\s*/, "");
      if (!pattern) throw new Error("unsupported empty case pattern");
      return { pattern, remainder: command.slice(index + 1).trim() };
    }
  }
  return undefined;
}

function staticGroupRedirection(source: string): boolean {
  return /^(?:\d*(?:<|>|>>|<>)\s*(?:[A-Za-z0-9_./-]+|"[^"$`]*"|'[^']*')\s*)+$/.test(source);
}

function structuralAsynchronousLists(nodes: ShellNode[]): ShellNode[] {
  const nested = nodes.map((node): ShellNode => {
    if (node.kind === "group") {
      node.nodes = structuralAsynchronousLists(node.nodes);
    } else if (node.kind === "case") {
      for (const arm of node.arms) arm.nodes = structuralAsynchronousLists(arm.nodes);
    }
    return node;
  });
  const result: ShellNode[] = [];
  let currentList: ShellNode[] = [];
  for (const node of nested) {
    currentList.push(node);
    if (node.terminator === "background") {
      node.terminator = "end";
      result.push({
        kind: "group",
        nodes: currentList,
        subshell: true,
        terminator: "background",
      });
      currentList = [];
    } else if (node.terminator === "sequence" || node.terminator === "end") {
      result.push(...currentList);
      currentList = [];
    }
  }
  result.push(...currentList);
  return result;
}

function shellNodeCount(nodes: readonly ShellNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "group") count += shellNodeCount(node.nodes);
    else if (node.kind === "case") {
      for (const arm of node.arms) count += shellNodeCount(arm.nodes);
    }
    for (const program of node.expansionPrograms ?? []) count += shellNodeCount(program.nodes);
  }
  return count;
}

function structuredShellProgram(
  source: string,
  expansionDepth = 0,
  legacyBacktickBody = false,
  inheritedLegacyDelimiterOwnership = false,
): ShellProgram {
  const ownedSource = legacyBacktickBody ? consumeLegacyBacktickLayer(source) : source;
  const legacyDelimiterOwnership = legacyBacktickBody || inheritedLegacyDelimiterOwnership;
  const parsed = shellCommandEvents(ownedSource, legacyDelimiterOwnership);
  const errors = [...parsed.errors];
  const rootNodes: ShellNode[] = [];
  interface CaseFrame {
    currentArm?: ShellCaseArm;
    node: ShellCaseNode;
    parentNodes: ShellNode[];
    type: "case";
  }
  interface GroupFrame {
    close: ")" | "}";
    node: ShellGroupNode;
    parentNodes: ShellNode[];
    type: "group";
  }
  const stack: Array<CaseFrame | GroupFrame> = [];
  let target = rootNodes;

  const listTerminator = (terminator: ShellTerminator): ShellListTerminator =>
    terminator === "case-break" || terminator === "case-fallthrough" || terminator === "case-retest"
      ? "end"
      : terminator;

  const expansionPrograms = (
    commands: readonly ShellExpansionCommand[],
  ): ShellProgram[] | undefined => {
    if (commands.length === 0) return undefined;
    if (expansionDepth >= MAX_SHELL_EXPANSION_DEPTH) {
      errors.push(
        `shell expansion nesting exceeds the supported depth limit of ${MAX_SHELL_EXPANSION_DEPTH}`,
      );
      return undefined;
    }
    const programs: ShellProgram[] = [];
    let nodeCount = 0;
    for (const command of commands) {
      const program = structuredShellProgram(
        command.source,
        expansionDepth + 1,
        command.legacyBacktickBody,
        command.legacyDelimiterOwnership,
      );
      errors.push(...program.errors);
      nodeCount += shellNodeCount(program.nodes);
      if (nodeCount > MAX_SHELL_EXPANSION_NODES) {
        errors.push(`shell expansion exceeds the node limit of ${MAX_SHELL_EXPANSION_NODES}`);
        break;
      }
      programs.push(program);
    }
    return programs;
  };

  for (const event of parsed.events) {
    let remainder = event.command.trim();
    let eventExpansionCommands = [...event.expansionCommands];
    const claimEventExpansionPrograms = (): ShellProgram[] | undefined => {
      if (eventExpansionCommands.length === 0) return undefined;
      const claimed = eventExpansionCommands;
      eventExpansionCommands = [];
      return expansionPrograms(claimed);
    };
    let attempts = 0;
    while (remainder) {
      attempts += 1;
      if (attempts > 32) {
        errors.push("unsupported or ambiguous nested shell structure");
        break;
      }
      const words = shellWordSpans(remainder);
      const first = words[0];
      if (first?.value === "esac") {
        const frame = stack.pop();
        if (frame?.type !== "case") {
          errors.push("unbalanced shell case terminator");
          break;
        }
        if (frame.node.arms.length === 0) errors.push("shell case has no arms");
        frame.node.terminator = listTerminator(event.terminator);
        target = frame.parentNodes;
        remainder = remainder.slice(first.end).trim();
        if (remainder) {
          errors.push("shell command after esac requires a structural separator");
          break;
        }
        continue;
      }

      if (first?.value === ")" || first?.value === "}") {
        const frame = stack.pop();
        if (frame?.type !== "group" || frame.close !== first.value) {
          errors.push("unbalanced shell group terminator");
          break;
        }
        frame.node.terminator = listTerminator(event.terminator);
        target = frame.parentNodes;
        remainder = remainder.slice(first.end).trim();
        if (remainder && !staticGroupRedirection(remainder)) {
          errors.push("shell command after a group requires a structural separator");
          break;
        }
        if (remainder) frame.node.redirection = remainder;
        const closingExpansionPrograms = claimEventExpansionPrograms();
        if (closingExpansionPrograms) {
          frame.node.expansionPrograms = [
            ...(frame.node.expansionPrograms ?? []),
            ...closingExpansionPrograms,
          ];
        }
        remainder = "";
        continue;
      }

      let caseRemainder: string | undefined;
      try {
        caseRemainder = caseHeaderRemainder(remainder);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "unsupported shell case header");
        break;
      }
      if (caseRemainder !== undefined) {
        const parent = target;
        const node: ShellCaseNode = {
          arms: [],
          expansionPrograms: claimEventExpansionPrograms(),
          kind: "case",
          terminator: "end",
        };
        parent.push(node);
        stack.push({ node, parentNodes: parent, type: "case" });
        remainder = caseRemainder;
        continue;
      }

      const frame = stack.at(-1);
      if (frame?.type === "case" && !frame.currentArm) {
        let parsedPattern: ReturnType<typeof casePattern>;
        try {
          parsedPattern = casePattern(remainder);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "unsupported shell case pattern");
          break;
        }
        if (!parsedPattern) {
          errors.push("unsupported or ambiguous shell case arm");
          break;
        }
        const arm: ShellCaseArm = {
          catchAll: parsedPattern.pattern === "*",
          nodes: [],
          pattern: parsedPattern.pattern,
          terminator: "break",
        };
        frame.node.arms.push(arm);
        frame.currentArm = arm;
        target = arm.nodes;
        remainder = parsedPattern.remainder;
        continue;
      }

      const leadingGroup = remainder.match(/^([({])(?:\s+|$)(.*)$/s);
      if (leadingGroup?.[1]) {
        const parent = target;
        const subshell = leadingGroup[1] === "(";
        const node: ShellGroupNode = {
          expansionPrograms: claimEventExpansionPrograms(),
          kind: "group",
          nodes: [],
          subshell,
          terminator: "end",
        };
        parent.push(node);
        stack.push({
          close: subshell ? ")" : "}",
          node,
          parentNodes: parent,
          type: "group",
        });
        target = node.nodes;
        remainder = leadingGroup[2]?.trim() ?? "";
        continue;
      }

      const last = words.at(-1);
      if (last && (last.value === ")" || last.value === "}")) {
        const command = remainder.slice(0, last.start).trim();
        if (command) {
          target.push({
            command,
            expansionPrograms: claimEventExpansionPrograms(),
            kind: "command",
            terminator: "sequence",
          });
        }
        const group = stack.pop();
        if (group?.type !== "group" || group.close !== last.value) {
          errors.push("unbalanced shell group terminator");
          break;
        }
        group.node.terminator = listTerminator(event.terminator);
        target = group.parentNodes;
        remainder = "";
        continue;
      }

      target.push({
        command: remainder,
        expansionPrograms: claimEventExpansionPrograms(),
        kind: "command",
        terminator: listTerminator(event.terminator),
      });
      remainder = "";
    }

    if (eventExpansionCommands.length > 0) {
      errors.push("unsupported unscoped shell expansion");
    }

    if (
      event.terminator === "case-break" ||
      event.terminator === "case-fallthrough" ||
      event.terminator === "case-retest"
    ) {
      const frame = stack.at(-1);
      if (frame?.type !== "case" || !frame.currentArm) {
        errors.push("shell case arm terminator is outside an active arm");
        continue;
      }
      frame.currentArm.terminator =
        event.terminator === "case-break"
          ? "break"
          : event.terminator === "case-fallthrough"
            ? "fallthrough"
            : "retest";
      frame.currentArm = undefined;
    }
  }
  if (stack.some((frame) => frame.type === "case")) errors.push("unbalanced shell case construct");
  if (stack.some((frame) => frame.type === "group")) {
    errors.push("unbalanced shell group construct");
  }
  return {
    errors: [...new Set(errors)],
    expandingHereDocument: parsed.expandingHereDocument,
    expansionCommands: parsed.expansionCommands,
    nodes: structuralAsynchronousLists(rootNodes),
  };
}

function shellCommandBuilds(segment: string): ShellBuildResult {
  const result: ShellBuildResult = { builds: [], errors: [] };
  const tokens = shellTokens(segment);
  const resolved = resolvedShellExecutable(tokens);
  if (resolved.error) {
    result.errors.push(resolved.error);
    return result;
  }
  const executable = resolved.index;
  if (executable === undefined || resolved.executable !== "docker") return result;
  let optionStart: number;
  if (tokens[executable + 1] === "build") optionStart = executable + 2;
  else if (tokens[executable + 1] === "buildx" && tokens[executable + 2] === "build") {
    optionStart = executable + 3;
  } else return result;

  const positional: string[] = [];
  let dockerfile: string | undefined;
  let optionsEnded = false;
  let invalid = false;
  for (let index = optionStart; index < resolved.end; index += 1) {
    const token = tokens[index] ?? "";
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && (token === "-f" || token === "--file")) {
      dockerfile = tokens[index + 1];
      if (!dockerfile) {
        result.errors.push("Docker build --file option is missing its value");
        invalid = true;
        break;
      }
      index += 1;
    } else if (!optionsEnded && token.startsWith("--file=")) {
      dockerfile = token.slice("--file=".length);
      if (!dockerfile) {
        result.errors.push("Docker build --file option is missing its value");
        invalid = true;
        break;
      }
    } else if (!optionsEnded && /^-f.+/.test(token)) {
      dockerfile = token.slice(2);
    } else if (!optionsEnded && DOCKER_BOOLEAN_BUILD_OPTIONS.has(token)) {
    } else if (!optionsEnded && DOCKER_VALUE_BUILD_OPTIONS.has(token)) {
      if (!tokens[index + 1]) {
        result.errors.push(`Docker build option ${token} is missing its value`);
        invalid = true;
        break;
      }
      index += 1;
    } else if (!optionsEnded && /^-(?:m|o|t).+/.test(token)) {
    } else if (!optionsEnded && token.startsWith("--") && token.includes("=")) {
    } else if (!optionsEnded && token.startsWith("-") && token !== "-") {
      result.errors.push(`unsupported or ambiguous Docker build option: ${token}`);
      invalid = true;
      break;
    } else {
      positional.push(token);
    }
  }
  if (invalid) return result;
  if (positional.length !== 1) {
    result.errors.push(
      `Docker build command has ${positional.length} positional contexts; expected exactly one`,
    );
    return result;
  }
  result.builds.push({ context: positional[0] ?? "", dockerfile });
  return result;
}

interface WorkflowLine {
  content: string;
  indent: number;
  raw: string;
}

interface StructuredStep {
  id?: string;
  run?: string;
  uses?: string;
  with: Map<string, string>;
}

interface StructuredJob {
  matrixEntries: Array<Map<string, string>>;
  name: string;
  steps: StructuredStep[];
}

interface StructuredWorkflow {
  errors: string[];
  jobs: StructuredJob[];
}

function workflowLines(source: string): WorkflowLine[] {
  return source.split(/\r?\n/).map((raw) => ({
    content: raw.trim(),
    indent: raw.match(/^ */)?.[0].length ?? 0,
    raw,
  }));
}

function meaningfulWorkflowLine(line: WorkflowLine): boolean {
  return line.content !== "" && !line.content.startsWith("#");
}

function workflowBlockEnd(lines: readonly WorkflowLine[], start: number): number {
  const startIndent = lines[start]?.indent ?? 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && meaningfulWorkflowLine(line) && line.indent <= startIndent) return index;
  }
  return lines.length;
}

function workflowChildIndent(
  lines: readonly WorkflowLine[],
  start: number,
  end: number,
): number | undefined {
  const parentIndent = lines[start]?.indent ?? -1;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    if (line && meaningfulWorkflowLine(line) && line.indent > parentIndent) return line.indent;
  }
  return undefined;
}

function directWorkflowMapping(
  lines: readonly WorkflowLine[],
  start: number,
  end: number,
  key: string,
): number | undefined {
  const childIndent = workflowChildIndent(lines, start, end);
  if (childIndent === undefined) return undefined;
  const matches: number[] = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    if (line?.indent === childIndent && line.content.match(new RegExp(`^${key}:`))) {
      matches.push(index);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function workflowMappingValue(content: string): { key: string; value: string } | undefined {
  const match = content.match(/^([A-Za-z_][\w-]*):(?:\s*(.*))?$/);
  if (!match?.[1]) return undefined;
  return { key: match[1], value: match[2] ?? "" };
}

interface WorkflowSequenceEntry {
  end: number;
  first: string;
  indent: number;
  start: number;
}

function workflowSequenceEntries(
  lines: readonly WorkflowLine[],
  start: number,
  end: number,
): WorkflowSequenceEntry[] {
  const itemIndent = workflowChildIndent(lines, start, end);
  if (itemIndent === undefined) return [];
  const starts: Array<Omit<WorkflowSequenceEntry, "end">> = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    const match = line?.indent === itemIndent ? line.content.match(/^-\s*(.*)$/) : undefined;
    if (line && match) starts.push({ first: match[1] ?? "", indent: itemIndent, start: index });
  }
  return starts.map((entry, index) => ({ ...entry, end: starts[index + 1]?.start ?? end }));
}

function workflowSequenceMapping(
  lines: readonly WorkflowLine[],
  entry: WorkflowSequenceEntry,
): Map<string, string> {
  const result = new Map<string, string>();
  const first = workflowMappingValue(entry.first);
  if (first && first.value !== "") result.set(first.key, yamlScalar(first.value));
  const mappingIndent = entry.indent + 2;
  for (let index = entry.start + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (!line || line.indent !== mappingIndent || !meaningfulWorkflowLine(line)) continue;
    const mapping = workflowMappingValue(line.content);
    if (mapping && mapping.value !== "") result.set(mapping.key, yamlScalar(mapping.value));
  }
  return result;
}

function workflowRunValue(
  lines: readonly WorkflowLine[],
  runIndex: number,
  stepEnd: number,
  rawValue: string,
): string {
  if (!/^[>|][+-]?$/.test(rawValue.trim())) return yamlScalar(rawValue);
  const runEnd = Math.min(workflowBlockEnd(lines, runIndex), stepEnd);
  const runIndent = lines[runIndex]?.indent ?? 0;
  const body = lines.slice(runIndex + 1, runEnd).filter((line) => line.indent > runIndent);
  const bodyIndent = body.find((line) => line.content !== "")?.indent ?? runIndent + 2;
  return body.map((line) => line.raw.slice(Math.min(bodyIndent, line.raw.length))).join("\n");
}

function structuredStep(
  lines: readonly WorkflowLine[],
  entry: WorkflowSequenceEntry,
): StructuredStep {
  const direct = workflowSequenceMapping(lines, entry);
  const step: StructuredStep = {
    id: direct.get("id"),
    uses: direct.get("uses"),
    with: new Map(),
  };
  const mappingIndent = entry.indent + 2;
  for (let index = entry.start + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (!line || line.indent !== mappingIndent || !meaningfulWorkflowLine(line)) continue;
    const mapping = workflowMappingValue(line.content);
    if (!mapping) continue;
    if (mapping.key === "run") {
      step.run = workflowRunValue(lines, index, entry.end, mapping.value);
    }
    if (mapping.key === "with" && mapping.value === "") {
      const withEnd = Math.min(workflowBlockEnd(lines, index), entry.end);
      const withIndent = workflowChildIndent(lines, index, withEnd);
      if (withIndent === undefined) continue;
      for (let cursor = index + 1; cursor < withEnd; cursor += 1) {
        const withLine = lines[cursor];
        if (!withLine || withLine.indent !== withIndent || !meaningfulWorkflowLine(withLine)) {
          continue;
        }
        const withMapping = workflowMappingValue(withLine.content);
        if (withMapping && withMapping.value !== "") {
          step.with.set(withMapping.key, yamlScalar(withMapping.value));
        }
      }
    }
  }
  const first = workflowMappingValue(entry.first);
  if (first?.key === "run") {
    step.run = workflowRunValue(lines, entry.start, entry.end, first.value);
  }
  return step;
}

function structuredMatrixEntries(
  lines: readonly WorkflowLine[],
  jobStart: number,
  jobEnd: number,
): Array<Map<string, string>> {
  const strategy = directWorkflowMapping(lines, jobStart, jobEnd, "strategy");
  if (strategy === undefined) return [];
  const strategyEnd = Math.min(workflowBlockEnd(lines, strategy), jobEnd);
  const matrix = directWorkflowMapping(lines, strategy, strategyEnd, "matrix");
  if (matrix === undefined) return [];
  const matrixEnd = Math.min(workflowBlockEnd(lines, matrix), strategyEnd);
  const include = directWorkflowMapping(lines, matrix, matrixEnd, "include");
  if (include === undefined) return [];
  const includeEnd = Math.min(workflowBlockEnd(lines, include), matrixEnd);
  return workflowSequenceEntries(lines, include, includeEnd).map((entry) =>
    workflowSequenceMapping(lines, entry),
  );
}

function structuredWorkflow(source: string, label: string): StructuredWorkflow {
  const errors: string[] = [];
  if (source.split(/\r?\n/).some((line) => /^\t+/.test(line))) {
    errors.push(`${label} uses unsupported tab indentation`);
  }
  const lines = workflowLines(source);
  const jobsIndexes = lines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => line.indent === 0 && line.content === "jobs:")
    .map(({ index }) => index);
  if (jobsIndexes.length !== 1) {
    errors.push(`${label} must contain exactly one structural jobs mapping`);
    return { errors, jobs: [] };
  }
  const jobsStart = jobsIndexes[0] ?? 0;
  const jobsEnd = workflowBlockEnd(lines, jobsStart);
  const jobIndent = workflowChildIndent(lines, jobsStart, jobsEnd);
  if (jobIndent === undefined) return { errors, jobs: [] };
  const jobStarts: Array<{ index: number; name: string }> = [];
  for (let index = jobsStart + 1; index < jobsEnd; index += 1) {
    const line = lines[index];
    const match =
      line?.indent === jobIndent ? line.content.match(/^([A-Za-z0-9_-]+):\s*$/) : undefined;
    if (match?.[1]) jobStarts.push({ index, name: match[1] });
  }
  const jobs = jobStarts.map((job, index) => {
    const jobEnd = jobStarts[index + 1]?.index ?? jobsEnd;
    const stepsIndex = directWorkflowMapping(lines, job.index, jobEnd, "steps");
    const steps =
      stepsIndex === undefined
        ? []
        : workflowSequenceEntries(
            lines,
            stepsIndex,
            Math.min(workflowBlockEnd(lines, stepsIndex), jobEnd),
          ).map((entry) => structuredStep(lines, entry));
    return {
      matrixEntries: structuredMatrixEntries(lines, job.index, jobEnd),
      name: job.name,
      steps,
    };
  });
  return { errors, jobs };
}

interface StructuredOutputAssignments {
  actionCanSucceed: boolean;
  errors: string[];
  records: Array<Map<string, string>>;
}

const MAX_OUTPUT_STATES = 256;

type ShellStatus = "failure" | "success" | "unknown";

interface ShellFlowState {
  builds: Array<{ context: string; dockerfile?: string }>;
  gate: ShellListTerminator;
  outputs: Map<string, string>;
  status: ShellStatus;
}

interface ShellFlowResult {
  active: ShellFlowState[];
  failedTerminated: ShellFlowState[];
  successfulTerminated: ShellFlowState[];
}

function exactOutputAssignment(command: string): { key: string; value: string } | undefined {
  const assignment = command.match(
    /^\s*echo\s+(?:(["'])([A-Za-z_][\w-]*)=([^"']*)\1|([A-Za-z_][\w-]*)=([^\s"';&|<>]+))\s*>>\s*(?:"(?:\$GITHUB_OUTPUT|\$\{GITHUB_OUTPUT\})"|\$GITHUB_OUTPUT|\$\{GITHUB_OUTPUT\})\s*$/,
  );
  const key = assignment?.[2] ?? assignment?.[4];
  const value = assignment?.[3] ?? assignment?.[5];
  return key && value !== undefined ? { key, value } : undefined;
}

type ShellRedirection =
  | { command: string; kind: "none" }
  | { command: string; kind: "stderr" }
  | { command: string; kind: "unsupported" };

function hasUnquotedShellRedirection(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "<" || character === ">") {
      return true;
    }
  }
  return false;
}

function shellRedirection(command: string, exactOutput: boolean): ShellRedirection {
  if (exactOutput || !hasUnquotedShellRedirection(command)) return { command, kind: "none" };
  const stderr = command.match(/^(.*\S)\s+(?:1?>&2)\s*$/s)?.[1];
  if (stderr && !hasUnquotedShellRedirection(stderr)) {
    const resolved = resolvedShellExecutable(shellTokens(stderr));
    if (!resolved.error && (resolved.executable === "echo" || resolved.executable === "printf")) {
      return { command: stderr, kind: "stderr" };
    }
  }
  return { command, kind: "unsupported" };
}

function cloneShellFlowState(state: ShellFlowState): ShellFlowState {
  return {
    builds: state.builds.map((build) => ({ ...build })),
    gate: state.gate,
    outputs: new Map(state.outputs),
    status: state.status,
  };
}

function deduplicateShellFlowStates(
  states: readonly ShellFlowState[],
  errors: string[],
): ShellFlowState[] {
  const unique = new Map<string, ShellFlowState>();
  for (const state of states) {
    const identity = JSON.stringify({
      builds: state.builds.map((build) => [build.context, build.dockerfile ?? ""]),
      gate: state.gate,
      outputs: [...state.outputs].sort(([left], [right]) => left.localeCompare(right)),
      status: state.status,
    });
    unique.set(identity, state);
    if (unique.size > MAX_OUTPUT_STATES) {
      errors.push("shell program has too many feasible states");
      return [];
    }
  }
  return [...unique.values()];
}

function emptyShellFlowResult(): ShellFlowResult {
  return { active: [], failedTerminated: [], successfulTerminated: [] };
}

function mergeShellFlowResults(
  results: readonly ShellFlowResult[],
  errors: string[],
): ShellFlowResult {
  return {
    active: deduplicateShellFlowStates(
      results.flatMap((result) => result.active),
      errors,
    ),
    failedTerminated: deduplicateShellFlowStates(
      results.flatMap((result) => result.failedTerminated),
      errors,
    ),
    successfulTerminated: deduplicateShellFlowStates(
      results.flatMap((result) => result.successfulTerminated),
      errors,
    ),
  };
}

function shellErrexitEnabled(tokens: readonly string[], executable: number): boolean {
  if (tokens[executable] !== "set") return false;
  const options = tokens.slice(executable + 1);
  return options.some(
    (option, index) =>
      /^-[^-]*e/.test(option) ||
      option === "-oerrexit" ||
      (option === "-o" && options[index + 1] === "errexit"),
  );
}

function staticTerminationStatus(
  tokens: readonly string[],
  executable: number,
  current: ShellStatus,
  errors: string[],
): ShellStatus | undefined {
  const arguments_ = tokens.slice(executable + 1);
  if (arguments_.length === 0) {
    if (current === "unknown") {
      errors.push("shell termination inherits an unknown status");
      return undefined;
    }
    return current;
  }
  if (arguments_.length !== 1 || !/^[+-]?\d+$/.test(arguments_[0] ?? "")) {
    errors.push("shell termination has a dynamic or unsupported status");
    return undefined;
  }
  const numeric = Number(arguments_[0]);
  if (!Number.isSafeInteger(numeric)) {
    errors.push("shell termination has an unsupported numeric status");
    return undefined;
  }
  return ((numeric % 256) + 256) % 256 === 0 ? "success" : "failure";
}

function shellGateBranches(
  state: ShellFlowState,
  errors: string[],
  strictUnknownStatus: boolean,
): { execute: ShellFlowState[]; skip: ShellFlowState[] } {
  if (state.gate === "and") {
    if (state.status === "success") return { execute: [state], skip: [] };
    if (state.status === "failure") return { execute: [], skip: [state] };
    if (strictUnknownStatus) errors.push("shell AND list depends on an unknown command status");
    return {
      execute: [{ ...cloneShellFlowState(state), status: "success" }],
      skip: [{ ...cloneShellFlowState(state), status: "failure" }],
    };
  }
  if (state.gate === "or") {
    if (state.status === "failure") return { execute: [state], skip: [] };
    if (state.status === "success") return { execute: [], skip: [state] };
    if (strictUnknownStatus) errors.push("shell OR list depends on an unknown command status");
    return {
      execute: [{ ...cloneShellFlowState(state), status: "failure" }],
      skip: [{ ...cloneShellFlowState(state), status: "success" }],
    };
  }
  return { execute: [state], skip: [] };
}

function evaluateShellCommand(
  node: ShellCommandNode,
  state: ShellFlowState,
  errors: string[],
  strictOutputProducer: boolean,
): ShellFlowResult {
  const result = emptyShellFlowResult();
  const updated = cloneShellFlowState(state);
  const assignment = exactOutputAssignment(node.command);
  if (assignment) {
    updated.outputs.set(assignment.key, assignment.value);
    updated.status = "success";
  }

  const redirection = shellRedirection(node.command, assignment !== undefined);
  if (strictOutputProducer && redirection.kind === "unsupported") {
    errors.push("unsupported output-producer shell redirection");
    return result;
  }

  const buildResult = shellCommandBuilds(node.command);
  errors.push(...buildResult.errors);
  updated.builds.push(...buildResult.builds);

  const tokens = shellTokens(redirection.command);
  const resolved = resolvedShellExecutable(tokens);
  if (resolved.error) {
    errors.push(resolved.error);
    return result;
  }
  const executable = resolved.index;
  const negated =
    executable !== undefined &&
    tokens.slice(0, executable).filter((token) => token === "!").length % 2 === 1;
  const executableArguments =
    executable === undefined ? [] : tokens.slice(executable + 1, resolved.end);
  if (redirection.kind === "unsupported" || executable === undefined) {
    updated.status = "unknown";
  } else if (shellErrexitEnabled(tokens, executable)) {
    errors.push("unsupported shell errexit mode: set -e");
    return result;
  } else if (
    !resolved.externalCommand &&
    (resolved.executable === "exit" || resolved.executable === "return")
  ) {
    const status = staticTerminationStatus(tokens, executable, updated.status, errors);
    if (!status) return result;
    updated.status = status;
    if (status === "success") result.successfulTerminated.push(updated);
    else result.failedTerminated.push(updated);
    return result;
  } else if (
    assignment ||
    ((resolved.executable === "true" || resolved.executable === ":") &&
      executableArguments.length === 0) ||
    resolved.executable === "echo" ||
    (resolved.executable === "printf" &&
      executableArguments.length > 0 &&
      /^(?:[^%]|%%|%s)*$/.test(executableArguments[0] ?? ""))
  ) {
    updated.status = "success";
  } else if (resolved.executable === "false" && executableArguments.length === 0) {
    updated.status = "failure";
  } else {
    updated.status = "unknown";
  }
  if (negated && updated.status !== "unknown") {
    updated.status = updated.status === "success" ? "failure" : "success";
  }

  if (resolved.replacesShell) {
    if (negated) {
      errors.push("unsupported negated exec replacement");
      return result;
    }
    const knownStatusTarget =
      (resolved.executable === "true" || resolved.executable === "false") &&
      executableArguments.length === 0;
    const dockerBuildTarget = resolved.executable === "docker" && buildResult.builds.length > 0;
    if (!knownStatusTarget && !dockerBuildTarget) {
      errors.push("unsupported static exec replacement target");
      return result;
    }
    if (updated.status === "success") result.successfulTerminated.push(updated);
    else if (updated.status === "failure") result.failedTerminated.push(updated);
    else if (strictOutputProducer) {
      errors.push("unsupported output-producer exec replacement status");
    } else {
      result.successfulTerminated.push(cloneShellFlowState(updated));
      result.failedTerminated.push(cloneShellFlowState(updated));
    }
    return result;
  }

  if (strictOutputProducer && (node.terminator === "pipe" || node.terminator === "background")) {
    errors.push(`unsupported output-producer shell ${node.terminator}`);
    return result;
  }
  updated.gate =
    node.terminator === "pipe" || node.terminator === "background" ? "sequence" : node.terminator;
  result.active.push(updated);
  return result;
}

function localizeConcurrentShellResult(
  evaluated: ShellFlowResult,
  incomingGate: ShellListTerminator,
  nodeTerminator: ShellListTerminator,
  errors: string[],
): ShellFlowResult {
  const pipelineComponent = incomingGate === "pipe" || nodeTerminator === "pipe";
  const backgroundComponent = nodeTerminator === "background";
  if (!pipelineComponent && !backgroundComponent) return evaluated;
  const componentStates = deduplicateShellFlowStates(
    [...evaluated.active, ...evaluated.failedTerminated, ...evaluated.successfulTerminated],
    errors,
  );
  return {
    active: componentStates.map((state) => ({
      ...cloneShellFlowState(state),
      gate:
        nodeTerminator === "pipe"
          ? "pipe"
          : nodeTerminator === "background"
            ? "sequence"
            : nodeTerminator,
      status: backgroundComponent ? "success" : "unknown",
    })),
    failedTerminated: [],
    successfulTerminated: [],
  };
}

function shellNodesUseConcurrentControl(nodes: readonly ShellNode[]): boolean {
  for (const node of nodes) {
    if (node.terminator === "pipe" || node.terminator === "background") return true;
    if (node.kind === "group" && shellNodesUseConcurrentControl(node.nodes)) return true;
    if (
      node.kind === "case" &&
      node.arms.some((arm) => shellNodesUseConcurrentControl(arm.nodes))
    ) {
      return true;
    }
  }
  return false;
}

function shellNodesUseGroupRedirection(nodes: readonly ShellNode[]): boolean {
  for (const node of nodes) {
    if (node.kind === "group") {
      if (node.redirection || shellNodesUseGroupRedirection(node.nodes)) return true;
    } else if (
      node.kind === "case" &&
      node.arms.some((arm) => shellNodesUseGroupRedirection(arm.nodes))
    ) {
      return true;
    }
  }
  return false;
}

function evaluateShellNodes(
  nodes: readonly ShellNode[],
  initialStates: readonly ShellFlowState[],
  errors: string[],
  strictOutputProducer: boolean,
  expansionDepth = 0,
): ShellFlowResult {
  let active = initialStates.map(cloneShellFlowState);
  const successfulTerminated: ShellFlowState[] = [];
  const failedTerminated: ShellFlowState[] = [];

  for (const node of nodes) {
    const next: ShellFlowResult[] = [];
    for (const state of active) {
      const branches = shellGateBranches(state, errors, strictOutputProducer);
      for (const skipped of branches.skip) {
        skipped.gate =
          node.terminator === "pipe" || node.terminator === "background"
            ? "sequence"
            : node.terminator;
        next.push({ active: [skipped], failedTerminated: [], successfulTerminated: [] });
      }
      for (const executing of branches.execute) {
        const expansionPrograms = node.expansionPrograms ?? [];
        if (expansionDepth >= MAX_SHELL_EXPANSION_DEPTH && expansionPrograms.length > 0) {
          errors.push(
            `shell expansion nesting exceeds the supported depth limit of ${MAX_SHELL_EXPANSION_DEPTH}`,
          );
        } else {
          for (const expansion of expansionPrograms) {
            const nested = structuredShellProgramBuilds(expansion, expansionDepth + 1);
            errors.push(...nested.errors);
            executing.builds.push(...nested.builds);
          }
        }
        if (node.kind === "command") {
          next.push(
            localizeConcurrentShellResult(
              evaluateShellCommand(node, executing, errors, strictOutputProducer),
              state.gate,
              node.terminator,
              errors,
            ),
          );
          continue;
        }

        if (node.kind === "group") {
          const group = evaluateShellNodes(
            node.nodes,
            [{ ...cloneShellFlowState(executing), gate: "sequence" }],
            errors,
            strictOutputProducer,
            expansionDepth,
          );
          if (node.subshell) {
            group.active.push(
              ...group.successfulTerminated.map((terminal) => ({
                ...cloneShellFlowState(terminal),
                status: "success" as const,
              })),
              ...group.failedTerminated.map((terminal) => ({
                ...cloneShellFlowState(terminal),
                status: "failure" as const,
              })),
            );
            group.successfulTerminated = [];
            group.failedTerminated = [];
          }
          for (const groupState of group.active) groupState.gate = node.terminator;
          if (node.redirection) {
            group.active.push({
              ...cloneShellFlowState(executing),
              gate: node.terminator,
              status: "failure",
            });
          }
          next.push(localizeConcurrentShellResult(group, state.gate, node.terminator, errors));
          continue;
        }

        const evaluateArm = (
          armIndex: number,
          armStates: readonly ShellFlowState[],
        ): ShellFlowResult => {
          const arm = node.arms[armIndex];
          if (!arm) {
            return {
              active: armStates.map(cloneShellFlowState),
              failedTerminated: [],
              successfulTerminated: [],
            };
          }
          const executed = evaluateShellNodes(
            arm.nodes,
            armStates.map((armState) => ({ ...cloneShellFlowState(armState), gate: "sequence" })),
            errors,
            strictOutputProducer,
            expansionDepth,
          );
          if (arm.terminator === "break") return executed;
          const continuing =
            arm.terminator === "fallthrough"
              ? evaluateArm(armIndex + 1, executed.active)
              : mergeShellFlowResults(
                  executed.active.map((armState) => selectArm(armIndex + 1, armState)),
                  errors,
                );
          return mergeShellFlowResults(
            [
              continuing,
              {
                active: [],
                failedTerminated: executed.failedTerminated,
                successfulTerminated: executed.successfulTerminated,
              },
            ],
            errors,
          );
        };

        const selectArm = (start: number, caseState: ShellFlowState): ShellFlowResult => {
          const selected: ShellFlowResult[] = [];
          let exhaustive = false;
          for (let index = start; index < node.arms.length; index += 1) {
            const arm = node.arms[index];
            if (!arm) continue;
            selected.push(evaluateArm(index, [cloneShellFlowState(caseState)]));
            if (arm.catchAll) {
              exhaustive = true;
              break;
            }
          }
          if (!exhaustive) {
            selected.push({
              active: [{ ...cloneShellFlowState(caseState), status: "success" }],
              failedTerminated: [],
              successfulTerminated: [],
            });
          }
          return mergeShellFlowResults(selected, errors);
        };

        const caseResult = selectArm(0, executing);
        for (const caseState of caseResult.active) caseState.gate = node.terminator;
        next.push(localizeConcurrentShellResult(caseResult, state.gate, node.terminator, errors));
      }
    }
    const merged = mergeShellFlowResults(next, errors);
    active = merged.active;
    successfulTerminated.push(...merged.successfulTerminated);
    failedTerminated.push(...merged.failedTerminated);
  }
  return {
    active: deduplicateShellFlowStates(active, errors),
    failedTerminated: deduplicateShellFlowStates(failedTerminated, errors),
    successfulTerminated: deduplicateShellFlowStates(successfulTerminated, errors),
  };
}

function structuredOutputAssignments(source: string): StructuredOutputAssignments {
  const program = structuredShellProgram(source);
  const errors = [...program.errors];
  if (program.expandingHereDocument || program.expansionCommands.length > 0) {
    errors.push("unsupported output-producer shell expansion");
    return { actionCanSucceed: false, errors: [...new Set(errors)], records: [] };
  }
  if (shellNodesUseConcurrentControl(program.nodes)) {
    errors.push("unsupported concurrent pipeline/background output producer");
    return { actionCanSucceed: false, errors: [...new Set(errors)], records: [] };
  }
  if (shellNodesUseGroupRedirection(program.nodes)) {
    errors.push("unsupported output-producer shell redirection");
    return { actionCanSucceed: false, errors: [...new Set(errors)], records: [] };
  }
  const evaluated = evaluateShellNodes(
    program.nodes,
    [{ builds: [], gate: "sequence", outputs: new Map(), status: "success" }],
    errors,
    true,
    0,
  );
  for (const state of evaluated.active) {
    if (state.status === "unknown") {
      errors.push("output producer ends with an unknown command status");
    }
  }
  const successful = [
    ...evaluated.active.filter((state) => state.status === "success"),
    ...evaluated.successfulTerminated,
  ];
  let records = successful.map((state) => state.outputs);
  if (records.every((record) => record.size === 0)) records = [];
  return {
    actionCanSucceed: successful.length > 0,
    errors: [...new Set(errors)],
    records,
  };
}

function structuredShellProgramBuilds(
  program: ShellProgram,
  expansionDepth: number,
): ShellBuildResult {
  const errors = [...program.errors];
  const evaluated = evaluateShellNodes(
    program.nodes,
    [{ builds: [], gate: "sequence", outputs: new Map(), status: "success" }],
    errors,
    false,
    expansionDepth,
  );
  const states = [
    ...evaluated.active,
    ...evaluated.failedTerminated,
    ...evaluated.successfulTerminated,
  ];
  const builds = new Map<string, { context: string; dockerfile?: string }>();
  for (const state of states) {
    for (const build of state.builds) {
      builds.set(`${build.context}\0${build.dockerfile ?? ""}`, build);
    }
  }
  return { builds: [...builds.values()], errors: [...new Set(errors)] };
}

function structuredShellBuilds(source: string, expansionDepth = 0): ShellBuildResult {
  return structuredShellProgramBuilds(
    structuredShellProgram(source, expansionDepth),
    expansionDepth,
  );
}

type ActionValue =
  | { kind: "literal"; value: string }
  | { key: string; kind: "matrix" }
  | { key: string; kind: "output"; stepId: string }
  | { kind: "unsupported"; value: string };

function parseActionValue(value: string): ActionValue {
  const matrix = value.match(/^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*}}$/);
  if (matrix?.[1]) return { key: matrix[1], kind: "matrix" };
  const output = value.match(
    /^\$\{\{\s*steps\.([A-Za-z_][\w-]*)\.outputs\.([A-Za-z_][\w-]*)\s*}}$/,
  );
  if (output?.[1] && output[2]) return { key: output[2], kind: "output", stepId: output[1] };
  return isExpression(value) ? { kind: "unsupported", value } : { kind: "literal", value };
}

function resolveStructuredAction(
  discovery: DiscoveryResult,
  job: StructuredJob,
  stepIndex: number,
  source: string,
): void {
  const step = job.steps[stepIndex];
  if (!step) return;
  const context = parseActionValue(step.with.get("context") ?? ".");
  const dockerfile = parseActionValue(step.with.get("file") ?? "Dockerfile");
  if (context.kind === "unsupported" || dockerfile.kind === "unsupported") {
    discovery.errors.push(
      `${source} job ${job.name} has unsupported or ambiguous Docker build inputs`,
    );
    return;
  }
  const usesMatrix = context.kind === "matrix" || dockerfile.kind === "matrix";
  const usesOutput = context.kind === "output" || dockerfile.kind === "output";
  if (usesMatrix && usesOutput) {
    discovery.errors.push(
      `${source} job ${job.name} mixes matrix and step-output Docker build inputs`,
    );
    return;
  }
  if (usesMatrix) {
    if (job.matrixEntries.length === 0) {
      discovery.errors.push(`${source} job ${job.name} has unresolved matrix Docker build inputs`);
      return;
    }
    for (const entry of job.matrixEntries) {
      const resolvedContext = context.kind === "matrix" ? entry.get(context.key) : context.value;
      const resolvedDockerfile =
        dockerfile.kind === "matrix" ? entry.get(dockerfile.key) : dockerfile.value;
      if (!resolvedContext || !resolvedDockerfile) {
        discovery.errors.push(
          `${source} job ${job.name} has incomplete matrix Docker build inputs`,
        );
        continue;
      }
      addRootBuild(discovery, resolvedContext, resolvedDockerfile, `${source} job ${job.name}`);
    }
    return;
  }
  if (usesOutput) {
    const outputValues = [context, dockerfile].filter(
      (value): value is Extract<ActionValue, { kind: "output" }> => value.kind === "output",
    );
    const outputStepIds = new Set(outputValues.map((value) => value.stepId));
    if (outputStepIds.size !== 1) {
      discovery.errors.push(`${source} job ${job.name} has ambiguous output producers`);
      return;
    }
    const producerId = [...outputStepIds][0];
    const producers = job.steps
      .slice(0, stepIndex)
      .filter((candidate) => candidate.id === producerId && candidate.run !== undefined);
    if (producers.length !== 1) {
      discovery.errors.push(
        `${source} job ${job.name} has unresolved output producer ${producerId}`,
      );
      return;
    }
    const outputAssignments = structuredOutputAssignments(producers[0]?.run ?? "");
    if (outputAssignments.errors.length > 0) {
      discovery.errors.push(
        ...outputAssignments.errors.map(
          (error) => `${source} job ${job.name} has unsupported output producer: ${error}`,
        ),
      );
      return;
    }
    if (!outputAssignments.actionCanSucceed) return;
    const records = outputAssignments.records;
    if (records.length === 0) {
      discovery.errors.push(`${source} job ${job.name} has unresolved outputs from ${producerId}`);
      return;
    }
    for (const record of records) {
      const resolvedContext = context.kind === "output" ? record.get(context.key) : context.value;
      const resolvedDockerfile =
        dockerfile.kind === "output" ? record.get(dockerfile.key) : dockerfile.value;
      if (!resolvedContext || !resolvedDockerfile) {
        discovery.errors.push(
          `${source} job ${job.name} has incomplete outputs from ${producerId}`,
        );
        continue;
      }
      addRootBuild(discovery, resolvedContext, resolvedDockerfile, `${source} job ${job.name}`);
    }
    return;
  }
  addRootBuild(discovery, context.value, dockerfile.value, `${source} job ${job.name}`);
}

function repositoryWorkflowFiles(rootDir: string): { errors: string[]; files: string[] } {
  const githubPath = join(rootDir, ".github");
  const workflowsPath = join(githubPath, "workflows");
  const githubMetadata = existingPathMetadata(githubPath);
  if (!githubMetadata) return { errors: [], files: [] };
  if (githubMetadata.isSymbolicLink() || !githubMetadata.isDirectory()) {
    return {
      errors: ["workflow owner directory .github is a symlink or not a regular directory"],
      files: [],
    };
  }
  const workflowsMetadata = existingPathMetadata(workflowsPath);
  if (!workflowsMetadata) return { errors: [], files: [] };
  if (workflowsMetadata.isSymbolicLink() || !workflowsMetadata.isDirectory()) {
    return {
      errors: ["workflow directory .github/workflows is a symlink or not a regular directory"],
      files: [],
    };
  }
  const fromRoot = relative(realpathSync(rootDir), realpathSync(workflowsPath));
  if (pathEscapesRepository(fromRoot)) {
    return { errors: ["workflow directory resolves outside the repository"], files: [] };
  }
  const errors: string[] = [];
  const files: string[] = [];
  for (const name of readdirSync(workflowsPath)) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const absolute = join(workflowsPath, name);
    const metadata = existingPathMetadata(absolute);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
      errors.push(`workflow file .github/workflows/${name} is a symlink or not a regular file`);
      continue;
    }
    files.push(absolute);
  }
  return { errors, files };
}

function discoverRootContextDockerfiles(rootDir: string): DiscoveryResult {
  const discovery: DiscoveryResult = { dockerfiles: new Set(), errors: [] };
  const workflows = repositoryWorkflowFiles(rootDir);
  discovery.errors.push(...workflows.errors);
  for (const workflow of workflows.files) {
    const relativeWorkflow = relative(rootDir, workflow).replaceAll("\\", "/");
    let source: string;
    try {
      source = readFileSync(workflow, "utf8");
    } catch {
      discovery.errors.push(`${relativeWorkflow} could not be read as a regular workflow file`);
      continue;
    }
    const parsed = structuredWorkflow(source, relativeWorkflow);
    discovery.errors.push(...parsed.errors);
    for (const job of parsed.jobs) {
      for (const [stepIndex, step] of job.steps.entries()) {
        if (/^docker\/build-push-action@/i.test(step.uses ?? "")) {
          resolveStructuredAction(discovery, job, stepIndex, relativeWorkflow);
        }
        if (step.run !== undefined) {
          const shell = structuredShellBuilds(step.run);
          discovery.errors.push(
            ...shell.errors.map((error) => `${relativeWorkflow} job ${job.name}: ${error}`),
          );
          for (const build of shell.builds) {
            addRootBuild(
              discovery,
              build.context,
              build.dockerfile,
              `${relativeWorkflow} job ${job.name}`,
            );
          }
        }
      }
    }
  }
  discovery.errors = [...new Set(discovery.errors)];
  return discovery;
}

export function rootContextDockerfiles(rootDir: string): Set<string> {
  const discovery = discoverRootContextDockerfiles(rootDir);
  if (discovery.errors.length > 0) throw new Error(discovery.errors.join("\n"));
  return discovery.dockerfiles;
}

function dockerfileInstructions(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  let escapeCharacter = "\\";
  for (const line of lines.slice(0, 8)) {
    const directive = line.match(/^\s*#\s*escape\s*=\s*([\\`])\s*$/i)?.[1];
    if (directive) {
      escapeCharacter = directive;
      break;
    }
    if (line.trim() !== "" && !line.trimStart().startsWith("#")) break;
  }

  const instructions: string[] = [];
  let current = "";
  for (const rawLine of lines) {
    const trimmedEnd = rawLine.trimEnd();
    const continued = trimmedEnd.endsWith(escapeCharacter);
    const part = continued ? trimmedEnd.slice(0, -1) : trimmedEnd;
    current += `${current ? " " : ""}${part.trim()}`;
    if (!continued) {
      if (current && !current.startsWith("#")) instructions.push(current);
      current = "";
    }
  }
  if (current) throw new Error("unterminated Dockerfile continuation");
  return instructions;
}

function instructionSources(
  instruction: string,
): { fromStage: boolean; sources: string[] } | undefined {
  const match = instruction.match(/^(COPY|ADD)\s+(.*)$/i);
  if (!match) return undefined;
  let body = match[2]?.trim() ?? "";
  let fromStage = false;
  while (body.startsWith("--")) {
    const option = body.match(/^(--[^\s]+)(?:\s+|$)/)?.[1];
    if (!option) throw new Error(`invalid COPY/ADD option: ${instruction}`);
    if (/^--from(?:=|$)/i.test(option)) fromStage = true;
    body = body.slice(option.length).trimStart();
    if (option.toLowerCase() === "--from") {
      const stage = body.match(/^(\S+)(?:\s+|$)/)?.[1];
      if (!stage) throw new Error(`invalid COPY --from option: ${instruction}`);
      body = body.slice(stage.length).trimStart();
    }
  }
  if (body.startsWith("[")) {
    let values: unknown;
    try {
      values = JSON.parse(body);
    } catch {
      throw new Error(`invalid JSON COPY/ADD instruction: ${instruction}`);
    }
    if (
      !Array.isArray(values) ||
      values.length < 2 ||
      values.some((value) => typeof value !== "string")
    ) {
      throw new Error(`invalid JSON COPY/ADD instruction: ${instruction}`);
    }
    return { fromStage, sources: (values as string[]).slice(0, -1) };
  }
  const values = shellTokens(body);
  if (values.length < 2) throw new Error(`invalid COPY/ADD instruction: ${instruction}`);
  return { fromStage, sources: values.slice(0, -1) };
}

function isBroadSource(source: string): boolean {
  if (isExpression(source)) return true;
  const contextRelative = source.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = posix.normalize(contextRelative || ".");
  return normalized === "." || normalized === "*" || normalized === "**" || normalized === "**/*";
}

function hasBroadContextCopyOrAdd(dockerfileContents: string): boolean {
  for (const instruction of dockerfileInstructions(dockerfileContents)) {
    const parsed = instructionSources(instruction);
    if (parsed && !parsed.fromStage && parsed.sources.some(isBroadSource)) return true;
  }
  return false;
}

function existingPathMetadata(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function pathEscapesRepository(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  );
}

function pathHasSymlink(rootDir: string, relativePath: string): boolean {
  let cursor = rootDir;
  for (const segment of relativePath.split("/")) {
    cursor = join(cursor, segment);
    const metadata = existingPathMetadata(cursor);
    if (!metadata) return false;
    if (metadata.isSymbolicLink()) return true;
  }
  return false;
}

function regularRepositoryFile(
  rootDir: string,
  relativePath: string,
): { absolute?: string; error?: string } {
  const safe = safeDockerfilePath(relativePath);
  if (!safe.path) return { error: safe.error ?? `unsafe repository path: ${relativePath}` };
  const absolute = join(rootDir, safe.path);
  const metadata = existingPathMetadata(absolute);
  if (!metadata) return { error: `${safe.path} is missing` };
  if (pathHasSymlink(rootDir, safe.path) || metadata.isSymbolicLink()) {
    return { error: `${safe.path} is a symlink, not a regular file` };
  }
  if (!metadata.isFile()) return { error: `${safe.path} is not a regular file` };
  const rootRealPath = realpathSync(rootDir);
  const fileRealPath = realpathSync(absolute);
  const fromRoot = relative(rootRealPath, fileRealPath);
  if (pathEscapesRepository(fromRoot)) {
    return { error: `${safe.path} resolves outside the repository` };
  }
  return { absolute };
}

interface IgnorePolicy {
  label: string;
  missingRules: string[];
  rules: string[];
  valid: boolean;
}

function readIgnorePolicy(
  rootDir: string,
  relativePath: string,
): { policy?: IgnorePolicy; error?: string } {
  const file = regularRepositoryFile(rootDir, relativePath);
  if (!file.absolute)
    return { error: `${relativePath} ignore policy ${file.error ?? "is invalid"}` };
  let rules: string[];
  try {
    rules = normalizedRuleLines(readFileSync(file.absolute, "utf8"));
    for (const rule of rules) parseIgnoreRule(rule);
  } catch (error) {
    return {
      error: `${relativePath} ignore policy has an invalid rule: ${error instanceof Error ? error.message : "unknown parse error"}`,
    };
  }
  return {
    policy: {
      label: relativePath,
      missingRules: ALL_REQUIRED_RULES.filter((rule) => !rules.includes(rule)),
      rules,
      valid: true,
    },
  };
}

function validateIgnorePolicy(
  policy: IgnorePolicy,
  ignoredPaths: readonly string[],
  violations: string[],
): void {
  for (const rule of policy.missingRules) {
    violations.push(`${policy.label} is missing required rule: ${rule}`);
  }
  for (const path of ignoredPaths) {
    try {
      if (sensitiveCandidate(path) && !dockerIgnoreExcludes(path, policy.rules)) {
        violations.push(
          `${policy.label} does not exclude sensitive ignored path from the Docker context: ${path}`,
        );
      }
    } catch (error) {
      violations.push(
        `${policy.label} could not safely classify ignored path ${path}: ${error instanceof Error ? error.message : "unknown path error"}`,
      );
    }
  }
}

export function collectDockerContextSecretViolations(rootDir: string): string[] {
  const violations: string[] = [];
  let ignoredPaths: string[] = [];
  try {
    ignoredPaths = enumerateSensitiveIgnoredPathNames(rootDir);
  } catch {
    violations.push("could not enumerate Git-ignored path names for the root Docker context");
  }

  const rootPolicyResult = readIgnorePolicy(rootDir, ".dockerignore");
  const rootPolicy = rootPolicyResult.policy;
  if (!rootPolicy) {
    violations.push(
      rootPolicyResult.error ?? ".dockerignore is missing from the root Docker build context",
    );
  } else {
    validateIgnorePolicy(rootPolicy, ignoredPaths, violations);
  }

  const discovery = discoverRootContextDockerfiles(rootDir);
  violations.push(...discovery.errors);
  for (const dockerfile of discovery.dockerfiles) {
    const dockerfileResult = regularRepositoryFile(rootDir, dockerfile);
    if (!dockerfileResult.absolute) {
      violations.push(dockerfileResult.error ?? `${dockerfile} is not a regular file`);
      continue;
    }

    const overridePath = `${dockerfile}.dockerignore`;
    const overrideMetadata = existingPathMetadata(join(rootDir, overridePath));
    let effectivePolicy = rootPolicy;
    if (overrideMetadata) {
      const overrideResult = readIgnorePolicy(rootDir, overridePath);
      if (!overrideResult.policy) {
        violations.push(overrideResult.error ?? `${overridePath} ignore policy is invalid`);
        continue;
      }
      effectivePolicy = overrideResult.policy;
      validateIgnorePolicy(effectivePolicy, ignoredPaths, violations);
    }
    if (!effectivePolicy) continue;

    try {
      const broad = hasBroadContextCopyOrAdd(readFileSync(dockerfileResult.absolute, "utf8"));
      if (broad && effectivePolicy.missingRules.length > 0) {
        violations.push(
          `${dockerfile} uses broad COPY/ADD with build context '.' while ${effectivePolicy.label} is incomplete`,
        );
      }
    } catch (error) {
      violations.push(
        `${dockerfile} could not be safely inspected for broad COPY/ADD: ${error instanceof Error ? error.message : "unknown Dockerfile parse error"}`,
      );
    }
  }
  return [...new Set(violations)];
}

function main(): void {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = collectDockerContextSecretViolations(rootDir);
  if (violations.length > 0) {
    console.error(
      `Docker context secret policy failed (${violations.length} path/rule name issue(s)):`,
    );
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Docker context secret policy passed: ${REQUIRED_DOCKERIGNORE_RULES.length} high-risk rules and ignored path names verified for every production root-context Dockerfile.`,
  );
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
