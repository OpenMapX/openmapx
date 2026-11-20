/**
 * Root Docker build-context policy. Candidate files are enumerated by name
 * through Git; this script never opens or prints their contents.
 *
 * A build with the repository root as its context reads the root
 * `.dockerignore`, or `<Dockerfile>.dockerignore` next to its Dockerfile when
 * that file exists. Every one of those files in the worktree must hold every
 * required rule and exclude every sensitive ignored path, whether or not a
 * workflow or script is known to build with it. Every conventionally named
 * Dockerfile must be a regular file, and an ignore-file name next to it must
 * not be a directory, so the policy Docker applies is always one checked here.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDockerIgnoreMatcher, normalizeCandidatePath } from "./dockerignore.ts";

const REQUIRED_DOCKERIGNORE_RULES = [
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

function gitPathNames(rootDir: string, args: readonly string[]): string[] {
  const output = execFileSync("git", ["ls-files", "-z", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

/**
 * A Dockerfile-specific ignore file. A name with nothing before
 * `.dockerignore` is a context's own ignore file, not an override.
 */
const OVERRIDE_PATHSPEC = ":(glob)**/*?.dockerignore";

function isOverridePolicy(path: string): boolean {
  const segments = path.split("/");
  return /.\.dockerignore$/.test(segments.at(-1) ?? "") && !segments.includes("node_modules");
}

/** Dockerfile names Docker and Podman users conventionally pass to a build. */
const DOCKERFILE_PATHSPECS = [
  ":(glob,icase)**/Dockerfile",
  ":(glob,icase)**/Dockerfile.*",
  ":(glob,icase)**/*.Dockerfile",
  ":(glob,icase)**/Containerfile",
  ":(glob,icase)**/Containerfile.*",
  ":(glob,icase)**/*.Containerfile",
] as const;

function isDockerfile(path: string): boolean {
  const segments = path.split("/");
  const basename = segments.at(-1) ?? "";
  return (
    /^(?:docker|container)file(?:\..+)?$|.\.(?:docker|container)file$/i.test(basename) &&
    !/\.dockerignore$/i.test(basename) &&
    !segments.includes("node_modules")
  );
}

/**
 * Git-ignored path names in the name classes sensitiveCandidate() evaluates,
 * Git-ignored Dockerfile-specific ignore files and Git-ignored Dockerfiles.
 * One walk serves all three, since listing ignored files is the slow part of
 * the check.
 */
export function enumerateSensitiveIgnoredPathNames(rootDir: string): string[] {
  return gitPathNames(rootDir, [
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ...SENSITIVE_IGNORED_PATHSPECS,
    OVERRIDE_PATHSPEC,
    ...DOCKERFILE_PATHSPECS,
  ]);
}

/**
 * Every Dockerfile-specific ignore file in the worktree outside installed
 * dependencies: tracked, untracked and, from `ignoredPaths`, Git-ignored.
 */
function overridePolicies(rootDir: string, ignoredPaths: readonly string[]): string[] {
  const visible = gitPathNames(rootDir, [
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    OVERRIDE_PATHSPEC,
  ]);
  return [...new Set([...visible, ...ignoredPaths])].filter(isOverridePolicy).sort();
}

/**
 * Every conventionally named Dockerfile in the worktree outside installed
 * dependencies: tracked, untracked and, from `ignoredPaths`, Git-ignored.
 * Git lists a symlink by its own name, so a symlinked Dockerfile is included.
 */
function dockerfiles(rootDir: string, ignoredPaths: readonly string[]): string[] {
  const visible = gitPathNames(rootDir, [
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...DOCKERFILE_PATHSPECS,
  ]);
  return [...new Set([...visible, ...ignoredPaths])].filter(isDockerfile).sort();
}

function existingPathMetadata(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
  const absolute = join(rootDir, relativePath);
  const metadata = existingPathMetadata(absolute);
  if (!metadata) return { error: "is missing" };
  if (pathHasSymlink(rootDir, relativePath)) return { error: "is a symlink, not a regular file" };
  if (!metadata.isFile()) return { error: "is not a regular file" };
  const fromRoot = relative(realpathSync(rootDir), realpathSync(absolute));
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    return { error: "resolves outside the repository" };
  }
  return { absolute };
}

/** Checks one ignore file and reports each missing rule and each exposed sensitive path. */
function validateIgnorePolicy(
  rootDir: string,
  label: string,
  ignoredPaths: readonly string[],
  violations: string[],
): void {
  const file = regularRepositoryFile(rootDir, label);
  if (!file.absolute) {
    violations.push(`${label} ignore policy ${file.error}`);
    return;
  }
  let rules: string[];
  let excludes: (path: string) => boolean;
  try {
    rules = normalizedRuleLines(readFileSync(file.absolute, "utf8"));
    excludes = createDockerIgnoreMatcher(rules);
  } catch (error) {
    violations.push(
      `${label} ignore policy has an invalid rule: ${error instanceof Error ? error.message : "unknown parse error"}`,
    );
    return;
  }
  for (const rule of ALL_REQUIRED_RULES) {
    if (!rules.includes(rule)) violations.push(`${label} is missing required rule: ${rule}`);
  }
  for (const path of ignoredPaths) {
    try {
      if (sensitiveCandidate(path) && !excludes(path)) {
        violations.push(
          `${label} does not exclude sensitive ignored path from the Docker context: ${path}`,
        );
      }
    } catch (error) {
      violations.push(
        `${label} could not safely classify ignored path ${path}: ${error instanceof Error ? error.message : "unknown path error"}`,
      );
    }
  }
}

export function collectDockerContextSecretViolations(rootDir: string): string[] {
  const violations: string[] = [];
  let ignoredPaths: string[] = [];
  let overrides: string[] = [];
  let builds: string[] = [];
  try {
    ignoredPaths = enumerateSensitiveIgnoredPathNames(rootDir);
    overrides = overridePolicies(rootDir, ignoredPaths);
    builds = dockerfiles(rootDir, ignoredPaths);
  } catch {
    violations.push("could not enumerate path names for the root Docker context through Git");
  }
  const policies = new Set([".dockerignore", ...overrides]);
  for (const dockerfile of builds) {
    // Which ignore file Docker reads beside a symlinked Dockerfile depends on
    // whether it follows the link, so neither candidate can be trusted.
    if (pathHasSymlink(rootDir, dockerfile)) {
      violations.push(`Dockerfile ${dockerfile} is a symlink, not a regular file`);
    }
    // Git never lists a directory, so an ignore-file name that is one is found
    // only beside its Dockerfile.
    const override = `${dockerfile}.dockerignore`;
    if (existingPathMetadata(join(rootDir, override))) policies.add(override);
  }
  for (const policy of policies) {
    validateIgnorePolicy(rootDir, policy, ignoredPaths, violations);
  }
  return violations;
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
    `Docker context secret policy passed: ${REQUIRED_DOCKERIGNORE_RULES.length} high-risk rules and ignored path names verified for the root .dockerignore and every Dockerfile-specific ignore file.`,
  );
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
