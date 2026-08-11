import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readMobileConfig } from "../config/mobileConfig.ts";
import { type ArtifactRecord, sha256 } from "./release-manifest.ts";
import type { ReleaseVersion, ToolchainPins } from "./schema.ts";

/**
 * Everything the release commands need to know about this machine and this
 * checkout, gathered once so the four entry points agree about it.
 */

export const mobileRoot = resolve(import.meta.dirname, "..");
export const repoRoot = resolve(mobileRoot, "../..");

/**
 * Drops the `$comment` keys the JSON files carry for readers.
 *
 * They are documentation, not data, and copying them into a provenance manifest
 * makes it noisier without making it more informative.
 */
function withoutComments<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutComments) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "$comment")
        .map(([key, nested]) => [key, withoutComments(nested)]),
    ) as T;
  }
  return value;
}

export function readVersion(): ReleaseVersion {
  return withoutComments(
    JSON.parse(readFileSync(resolve(mobileRoot, "release/version.json"), "utf8")),
  );
}

export function readToolchains(): ToolchainPins {
  return withoutComments(
    JSON.parse(readFileSync(resolve(mobileRoot, "release/toolchains.json"), "utf8")),
  );
}

/** The directory this release's artifacts go in. Ignored, never committed. */
export function distDir(version: ReleaseVersion): string {
  return resolve(repoRoot, "dist/mobile", version.marketingVersion);
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function gitState(): {
  commit: string;
  tag: string | null;
  dirty: boolean;
  dirtyFiles: string[];
} {
  const commit = git(["rev-parse", "HEAD"]);
  // `--porcelain` lists tracked modifications; untracked files are not a
  // reproducibility problem because they are not in the build.
  const dirtyFiles = git(["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  let tag: string | null = null;
  try {
    // Silenced: "no tag here" is the ordinary case and git says so on stderr.
    tag = execFileSync("git", ["describe", "--exact-match", "--tags", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    tag = null;
  }
  return { commit, tag, dirty: dirtyFiles.length > 0, dirtyFiles };
}

/**
 * The major version of the JDK on PATH, or null when there is none.
 *
 * `java -version` writes to stderr, which is why the output is read from there
 * rather than from stdout — a detail that costs an afternoon if missed.
 */
export function javaMajor(): number | null {
  // `spawnSync` rather than `execFileSync` because `java -version` exits 0 and
  // writes to *stderr*, so reading only stdout finds an empty string and
  // silently reports "no JDK" on a machine that has one.
  const result = spawnSync("java", ["-version"], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const match = output.match(/version "(\d+)/);
  return match ? Number(match[1]) : null;
}

export function identity() {
  const config = readMobileConfig(process.env);
  return { appId: config.appId, scheme: config.scheme, origin: config.webOrigin };
}

export function recordFile(path: string): ArtifactRecord | null {
  if (!existsSync(path)) return null;
  const contents = readFileSync(path);
  return {
    path: path.replace(`${repoRoot}/`, ""),
    sha256: sha256(contents),
    bytes: statSync(path).size,
  };
}

/** The committed native dependency locks, if any have been captured yet. */
export function nativeLocks(): ArtifactRecord[] {
  const candidates = [
    resolve(mobileRoot, "native-locks/ios/Podfile.lock"),
    resolve(mobileRoot, "native-locks/android/gradle.lockfile"),
  ];
  return candidates.map(recordFile).filter((record): record is ArtifactRecord => record !== null);
}
