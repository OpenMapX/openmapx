#!/usr/bin/env node
/**
 * Proves that Continuous Native Generation is actually continuous.
 *
 * Generates `ios/` and `android/` twice from a clean state and compares the
 * policy-relevant surface of both runs. If the two disagree, generation is not
 * deterministic; if either disagrees with the committed configuration, someone
 * hand-edited build output. Both are the failure mode this whole architecture
 * exists to prevent, so both fail the command.
 *
 * Deletion is scoped to exactly the two generated directories. Nothing else is
 * removed, ever.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedNativeSurface } from "./expectedNativeSurface.ts";
import { checkGeneratedNativeSurface } from "./generatedNativeChecks.ts";
import {
  hashNormalizedSurface,
  type NormalizedNativeSurface,
  normalizeGeneratedNativeSurface,
} from "./normalizeGeneratedNative.ts";
import { expoLocationManifestPaths, readGeneratedNativeSurface } from "./readGeneratedNative.ts";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(mobileRoot, "../..");

/** The only paths this script is ever allowed to delete. */
const GENERATED_DIRECTORIES = ["ios", "android"] as const;

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      // CocoaPods refuses to run under a non-UTF-8 locale, and a developer's
      // shell settings must not change what this check generates.
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
}

function removeGeneratedProjects(): void {
  for (const directory of GENERATED_DIRECTORIES) {
    const target = join(mobileRoot, directory);
    // Belt and braces: never delete anything outside `apps/mobile`.
    if (!target.startsWith(`${mobileRoot}/`)) {
      throw new Error(`refusing to delete outside the mobile app: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
  }
}

/** Fails if Git tracks any file inside a generated project. */
function assertGeneratedProjectsAreUntracked(): void {
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", "apps/mobile/ios", "apps/mobile/android"],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  if (tracked.length > 0) {
    throw new Error(
      `generated native projects must never be tracked; Git reports:\n${tracked
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`,
    );
  }
}

async function generateAndNormalize(pass: number): Promise<NormalizedNativeSurface> {
  console.log(`\n[clean-prebuild-check] pass ${pass}: regenerating from a clean state`);
  removeGeneratedProjects();
  run("npx", ["--no-install", "expo", "prebuild", "--clean"], mobileRoot);

  const generated = await readGeneratedNativeSurface(
    mobileRoot,
    expoLocationManifestPaths(mobileRoot),
  );
  const failures = checkGeneratedNativeSurface(generated, expectedNativeSurface(process.env));
  if (failures.length > 0) {
    throw new Error(
      `pass ${pass} produced a native surface that disagrees with the committed config:\n${failures
        .map((failure) => `  - ${failure}`)
        .join("\n")}`,
    );
  }
  return normalizeGeneratedNativeSurface(generated);
}

async function main(): Promise<number> {
  try {
    if (!existsSync(join(mobileRoot, "app.config.ts"))) {
      throw new Error("apps/mobile/app.config.ts is missing");
    }
    const first = await generateAndNormalize(1);
    const second = await generateAndNormalize(2);
    assertGeneratedProjectsAreUntracked();

    const firstHash = hashNormalizedSurface(first);
    const secondHash = hashNormalizedSurface(second);
    if (firstHash !== secondHash) {
      console.error("\n[clean-prebuild-check] the two generations disagree on policy:");
      console.error(`  pass 1: ${JSON.stringify(first, null, 2)}`);
      console.error(`  pass 2: ${JSON.stringify(second, null, 2)}`);
      return 1;
    }
    console.log(
      `\n[clean-prebuild-check] two clean generations agree (${firstHash.slice(0, 16)}…)`,
    );
    console.log("[clean-prebuild-check] generated projects are untracked");
    return 0;
  } catch (error) {
    console.error(`\n[clean-prebuild-check] ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = await main();
