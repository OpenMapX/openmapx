#!/usr/bin/env node
/**
 * Validates one sanitized QA report against the closed evidence schema.
 *
 * Usage: `pnpm mobile:qa:validate <report.json> [more.json ...]`
 *
 * Everything runs locally; no report is ever uploaded anywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateFeasibilityReport } from "./validateReport.ts";

const mobileRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(mobileRoot, "../..");

/**
 * `pnpm mobile:qa:validate` runs with the working directory set to
 * `apps/mobile`, but a caller naturally types a repository-relative path. Accept
 * either rather than making the caller guess.
 */
function locate(path: string): string {
  for (const candidate of [resolve(path), resolve(repoRoot, path), resolve(mobileRoot, path)]) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(path);
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: validate-report.mts <report.json> [more.json ...]");
  process.exit(2);
}

let failed = false;
for (const path of paths) {
  const absolute = locate(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    console.error(`✗ ${path}: ${(error as Error).message}`);
    failed = true;
    continue;
  }
  const result = validateFeasibilityReport(parsed);
  if (result.ok) {
    console.log(`✓ ${path}`);
  } else {
    failed = true;
    console.error(`✗ ${path}`);
    for (const error of result.errors) console.error(`    ${error}`);
  }
}

process.exitCode = failed ? 1 : 0;
