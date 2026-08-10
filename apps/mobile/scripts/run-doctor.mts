#!/usr/bin/env node
/**
 * Runs `expo-doctor` and applies this project's policy to its findings.
 *
 * See `doctorPolicy.ts` for the single tolerated case: an SDK patch wave that
 * this workspace's `minimumReleaseAge` supply-chain rule currently forbids
 * installing. Everything else fails, and the tolerated case is printed rather
 * than hidden.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideDoctorOutcome,
  type ExpectedVersionPublishedAt,
  parseDoctorFindings,
  parseOutOfDatePackages,
  SDK_VERSION_CHECK,
} from "./doctorPolicy.ts";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(mobileRoot, "../..");

/** Reads `minimumReleaseAge` (minutes) from the workspace supply-chain policy. */
function minimumReleaseAgeMs(): number {
  const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const match = workspace.match(/^minimumReleaseAge:\s*(\d+)\s*$/m);
  // Absent means pnpm imposes no delay, so nothing can be blocked by it.
  return match ? Number(match[1]) * 60_000 : 0;
}

/** Publish time of the exact version expo-doctor asks for, straight from the registry. */
function publishedAtFor(
  packages: ReturnType<typeof parseOutOfDatePackages>,
): ExpectedVersionPublishedAt {
  const result: ExpectedVersionPublishedAt = new Map();
  for (const pkg of packages) {
    const version = pkg.expected.replace(/^[~^]/, "");
    try {
      const raw = execFileSync("npm", ["view", `${pkg.name}@${version}`, "time", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      });
      const times = JSON.parse(raw) as Record<string, string>;
      const stamp = times[version];
      result.set(pkg.name, stamp ? new Date(stamp) : null);
    } catch {
      // Unknown publish date is treated as "not tolerated" by the policy.
      result.set(pkg.name, null);
    }
  }
  return result;
}

const result = spawnSync("npx", ["--no-install", "expo-doctor"], {
  cwd: mobileRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

if (result.error) {
  console.error(`\n[mobile:doctor] could not run expo-doctor: ${result.error.message}`);
  process.exitCode = 1;
} else {
  const sdkFinding = parseDoctorFindings(output).find((f) => f.title === SDK_VERSION_CHECK);
  const decision = decideDoctorOutcome(output, {
    publishedAt: sdkFinding ? publishedAtFor(parseOutOfDatePackages(sdkFinding.detail)) : new Map(),
    minimumReleaseAgeMs: minimumReleaseAgeMs(),
    now: new Date(),
  });

  for (const finding of decision.tolerated) {
    console.log(
      `\n[mobile:doctor] tolerated by policy: ${finding.title}\n` +
        "  Every newer version is younger than this workspace's minimumReleaseAge, so\n" +
        "  pnpm refuses to install it. The gate will demand the upgrade once it ages in.",
    );
  }
  if (decision.ok) {
    console.log("\n[mobile:doctor] no blocking findings");
    process.exitCode = 0;
  } else {
    console.error(`\n[mobile:doctor] ${decision.blocking.length} blocking finding(s):`);
    for (const finding of decision.blocking) console.error(`  - ${finding.title}`);
    process.exitCode = 1;
  }
}
