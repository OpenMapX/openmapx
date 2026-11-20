import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** The offline repository policy checks, as root package scripts, in the order they run. */
export const POLICY_CHECKS = [
  "check-legal-tables",
  "check-legal-updated",
  "check-data-flows",
  "check-subject-data",
  "check-license-metadata",
  "check-air-quality-release-gates",
  "check-toolchain-pins",
  "check-feed-ids",
  "check-credential-keys",
  "check-dockerfile-sync",
  "check-image-size-dos",
  "check-docker-context-secrets",
  "check-migration-order",
  "check-ops-authority",
  "check-declared-imports",
  "check-integration-cache-writes",
  "check-entur-graphql",
  "check-entur-geocoder",
  "check-mbta",
  "check-otp",
  "check-api-sdk",
  "check-data-manager-openapi",
  "check-data-manager-sdk",
];

/**
 * Runs every check, even after one fails, and returns the names of the failed
 * checks. `run` receives a script name and returns its exit status.
 *
 * @param {(name: string) => number} run
 * @param {readonly string[]} [checks]
 * @returns {string[]}
 */
export function runPolicyChecks(run, checks = POLICY_CHECKS) {
  return checks.filter((name) => run(name) !== 0);
}

/** Runs one root package script with inherited output and environment. */
function runScript(name) {
  const result = spawnSync("pnpm", ["run", name], { stdio: "inherit" });
  if (result.error) console.error(`${name}: ${result.error.message}`);
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const failed = runPolicyChecks(runScript);
  if (failed.length > 0) {
    console.error(
      `\n${failed.length} of ${POLICY_CHECKS.length} policy checks failed:\n${failed.map((name) => `  - ${name}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${POLICY_CHECKS.length} policy checks passed.`);
  }
}
