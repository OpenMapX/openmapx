#!/usr/bin/env node
/**
 * Everything that must be true before a release is built.
 *
 * Fail-closed on purpose. Each check here corresponds to a way a release goes
 * wrong that is cheap to catch now and expensive to catch later — a dirty
 * worktree that makes the build unreproducible, a version code the store will
 * reject after the upload, a permission that arrived through a dependency.
 *
 * It builds nothing, signs nothing, and uploads nothing. It also never edits
 * `version.json`: a script that bumped the version would remove the one
 * deliberate human step in the process.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  distDir,
  gitState,
  identity,
  javaMajor,
  readToolchains,
  readVersion,
  repoRoot,
} from "./context.ts";
import { compareWithPrevious, validateEnvironment, validateReleaseVersion } from "./schema.ts";

const version = readVersion();
const toolchains = readToolchains();
const git = gitState();
const app = identity();

const failures: string[] = [];

for (const issue of validateReleaseVersion(version)) {
  failures.push(`version.json ${issue.field}: ${issue.message}`);
}

for (const issue of validateEnvironment(
  {
    nodeMajor: Number(process.versions.node.split(".")[0]),
    javaMajor: javaMajor(),
    origin: app.origin,
    appId: app.appId,
    dirtyTrackedFiles: git.dirtyFiles,
  },
  toolchains,
  version,
)) {
  failures.push(`environment ${issue.field}: ${issue.message}`);
}

/** The previous release, read from the last mobile tag rather than a registry. */
function previousRelease(): ReturnType<typeof readVersion> | null {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "mobile-v*"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const contents = execFileSync("git", ["show", `${tag}:apps/mobile/release/version.json`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(contents);
  } catch {
    // No previous mobile release. The first one has nothing to compare against.
    return null;
  }
}

for (const issue of compareWithPrevious(version, previousRelease())) {
  failures.push(`against the previous release, ${issue.field}: ${issue.message}`);
}

/** The gates that already exist, run rather than re-implemented. */
const GATES: { label: string; command: string; args: string[] }[] = [
  { label: "expo doctor", command: "pnpm", args: ["mobile:verify"] },
  { label: "clean CNG generation", command: "pnpm", args: ["mobile:prebuild:check"] },
  { label: "headless background bundle", command: "pnpm", args: ["mobile:bundle:check"] },
  {
    label: "reviewed permission surface",
    command: "pnpm",
    args: [
      "-C",
      "apps/mobile",
      "exec",
      "tsx",
      "scripts/assert-release-permissions.mts",
      "--generated",
    ],
  },
  {
    label: "no unreviewed code path",
    command: "pnpm",
    args: ["-C", "apps/mobile", "exec", "tsx", "scripts/assert-no-community-runtime.mts"],
  },
  {
    label: "dependency licences and SDKs",
    command: "pnpm",
    args: ["-C", "apps/mobile", "exec", "tsx", "compliance/dependency-inventory.mts", "--check"],
  },
  {
    label: "store worksheets match the registry",
    command: "pnpm",
    args: ["-C", "apps/mobile", "exec", "tsx", "compliance/store-answers.mts", "--check"],
  },
  {
    label: "verified link associations",
    command: "pnpm",
    args: [
      "-C",
      "apps/mobile",
      "exec",
      "tsx",
      "scripts/assert-store-links.mts",
      "--local",
      "../../services/well-known/config/html",
    ],
  },
  { label: "tests", command: "pnpm", args: ["test"] },
  { label: "types", command: "pnpm", args: ["check-types"] },
  { label: "lint", command: "pnpm", args: ["lint"] },
  { label: "web build", command: "pnpm", args: ["build"] },
];

const skipGates = process.argv.includes("--skip-gates");

if (failures.length === 0 && !skipGates) {
  for (const gate of GATES) {
    process.stdout.write(`[release:prepare] ${gate.label}… `);
    try {
      execFileSync(gate.command, gate.args, { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
      console.log("ok");
    } catch {
      console.log("FAILED");
      failures.push(`gate "${gate.label}" failed; run it directly to see why`);
    }
  }
}

if (failures.length > 0) {
  console.error("\n[release:prepare] not ready to build:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

const output = distDir(version);
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, "prepare.json"),
  `${JSON.stringify(
    {
      preparedAtMs: Date.now(),
      git,
      version,
      identity: app,
      gatesRun: skipGates ? [] : GATES.map((gate) => gate.label),
    },
    null,
    2,
  )}\n`,
);

console.log(`\n[release:prepare] ready. Artifacts will be written to ${output}`);
console.log("[release:prepare] nothing has been built, signed, or uploaded.");
