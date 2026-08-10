#!/usr/bin/env node
/**
 * What actually ships inside the binary, and under what terms.
 *
 * Two questions this answers that a package manifest does not. First, whether
 * anything bundled carries a licence the store distribution terms cannot
 * accommodate — a GPL-or-AGPL-only dependency inside a signed binary is a
 * genuine problem, not a formality. Second, whether an SDK has arrived that
 * collects data nobody declared: an analytics library, a crash reporter, an
 * advertising identifier.
 *
 * It reads the committed dependency declarations and the installed packages
 * rather than the generated projects, because the generated projects are
 * disposable and this needs to be answerable before one exists.
 *
 * `--check` fails on any finding; without it, the inventory is printed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const mobileRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(mobileRoot, "../..");

interface Entry {
  name: string;
  version: string;
  license: string;
}

interface Finding {
  severity: "error" | "note";
  message: string;
}

const findings: Finding[] = [];

/**
 * Licences that cannot ship inside a store binary without a resolved
 * distribution decision. Our own AGPL packages are handled separately, because
 * the CLA makes them relicensable — a third party's are not.
 */
const BLOCKING_LICENSES = [
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-1.0",
  "AGPL-3.0",
  "SSPL-1.0",
  "BUSL-1.1",
  "CC-BY-NC",
  "Commons-Clause",
];

/** SDK names that would mean the privacy answers are wrong. */
const FORBIDDEN_SDK_PATTERNS = [
  "sentry",
  "bugsnag",
  "firebase-analytics",
  "google-analytics",
  "amplitude",
  "mixpanel",
  "appsflyer",
  "adjust",
  "branch-sdk",
  "onesignal",
  "facebook-sdk",
  "react-native-fbsdk",
  "expo-updates",
  "expo-tracking-transparency",
];

const manifest = JSON.parse(readFileSync(resolve(mobileRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const runtimeDependencies = Object.keys(manifest.dependencies ?? {});

/** Resolves a package's declared licence from its installed manifest. */
function licenseOf(name: string): string {
  for (const base of [resolve(mobileRoot, "node_modules"), resolve(repoRoot, "node_modules")]) {
    const path = resolve(base, name, "package.json");
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as {
        license?: string | { type?: string };
        version?: string;
      };
      const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
      return license ?? "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  }
  return "UNRESOLVED";
}

function versionOf(name: string): string {
  for (const base of [resolve(mobileRoot, "node_modules"), resolve(repoRoot, "node_modules")]) {
    const path = resolve(base, name, "package.json");
    if (!existsSync(path)) continue;
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version ?? "unknown";
    } catch {
      return "unknown";
    }
  }
  return manifest.dependencies?.[name] ?? "unknown";
}

const entries: Entry[] = runtimeDependencies.map((name) => ({
  name,
  version: versionOf(name),
  license: licenseOf(name),
}));

for (const entry of entries) {
  // Workspace packages are ours; their terms are the subject of the licensing
  // decision recorded in the release runbook, not of this check.
  const isWorkspace = entry.name.startsWith("@openmapx/");

  if (!isWorkspace && BLOCKING_LICENSES.some((license) => entry.license.startsWith(license))) {
    findings.push({
      severity: "error",
      message: `${entry.name}@${entry.version} is ${entry.license}, which a signed store binary cannot bundle without a resolved distribution decision`,
    });
  }
  if (!isWorkspace && (entry.license === "UNKNOWN" || entry.license === "UNRESOLVED")) {
    findings.push({
      severity: "error",
      message: `${entry.name}@${entry.version} declares no licence — an unknown licence is not a permissive one`,
    });
  }
  if (FORBIDDEN_SDK_PATTERNS.some((pattern) => entry.name.includes(pattern))) {
    findings.push({
      severity: "error",
      message: `${entry.name} is present, which would make the privacy answers wrong`,
    });
  }
}

/** Our own AGPL packages, which the licensing decision has to account for. */
const workspaceAgpl = entries.filter(
  (entry) => entry.name.startsWith("@openmapx/") && entry.license.startsWith("AGPL"),
);
for (const entry of workspaceAgpl) {
  findings.push({
    severity: "note",
    message: `${entry.name} is ${entry.license}; the shell therefore ships as AGPL until this is relicensed (see docs/docs/developer/mobile-release.md)`,
  });
}

/** Native locks, which pin what the generated projects will resolve. */
const locksDir = resolve(mobileRoot, "native-locks");
const locks = existsSync(locksDir) ? readdirSync(locksDir) : [];

if (process.argv.includes("--check")) {
  const errors = findings.filter((finding) => finding.severity === "error");
  for (const finding of findings) {
    const prefix = finding.severity === "error" ? "✗" : "•";
    console[finding.severity === "error" ? "error" : "log"](
      `[dependency-inventory] ${prefix} ${finding.message}`,
    );
  }
  if (errors.length > 0) process.exit(1);
  console.log(
    `[dependency-inventory] ${entries.length} runtime dependencies, no blocking licence or undeclared SDK`,
  );
} else {
  console.log(`# Mobile runtime dependency inventory\n`);
  console.log(`| Package | Version | Licence |`);
  console.log(`| --- | --- | --- |`);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`| ${entry.name} | ${entry.version} | ${entry.license} |`);
  }
  console.log(`\nNative locks present: ${locks.length > 0 ? locks.join(", ") : "none yet"}`);
  for (const finding of findings) console.log(`\n${finding.severity}: ${finding.message}`);
}
