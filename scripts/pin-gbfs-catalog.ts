/**
 * Maintainer tool: pin the MobilityData GBFS systems registry the release
 * ships, by rewriting `infra/docker/gbfs-catalog.lock.json` and the
 * `MOBILITYDATA_GBFS_CATALOG_COMMIT` it is paired with in
 * `@openmapx/transitous-core` together. Run it in a development checkout and
 * commit the result; the operations agent's bundle then carries the pin. No
 * deployment command rewrites these files.
 *
 *   pnpm pin:gbfs-catalog [--yes]
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  decodeGbfsCatalogLock,
  type GbfsCatalogLock,
} from "../packages/transitous-core/src/catalog-pins";
import { parseMobilityDataGbfsCsv } from "../packages/transitous-core/src/gbfs-catalog";

/** Plain console output: maintainer scripts run from the repository root, without the CLI's packages. */
const log = {
  info: (message: string) => console.log(message),
  ok: (message: string) => console.log(`✓ ${message}`),
  warn: (message: string) => console.error(`⚠ ${message}`),
  err: (message: string) => console.error(`✗ ${message}`),
  dim: (message: string) => console.log(message),
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOBILITYDATA_REPO_API = "https://api.github.com/repos/MobilityData/gbfs/commits/master";
const LOCK_PATH = join("infra", "docker", "gbfs-catalog.lock.json");
const CONSTANTS_PATH = join("packages", "transitous-core", "src", "constants.ts");
const COMMIT_LITERAL = /(export const MOBILITYDATA_GBFS_CATALOG_COMMIT = ")[0-9a-f]{40}(";)/;

export async function resolveGbfsCandidate(
  lockedBy: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<{ lock: GbfsCatalogLock; countryCounts: Map<string, number> }> {
  const commitResponse = await fetchImpl(MOBILITYDATA_REPO_API, {
    headers: { "User-Agent": "Open-MapX-gbfs-catalog-pin" },
  });
  if (!commitResponse.ok)
    throw new Error(`MobilityData commit lookup failed: HTTP ${commitResponse.status}`);
  const commitJson = (await commitResponse.json()) as { sha?: unknown };
  if (typeof commitJson.sha !== "string" || !/^[0-9a-f]{40}$/.test(commitJson.sha)) {
    throw new Error("MobilityData commit lookup returned an invalid SHA");
  }
  const url = `https://raw.githubusercontent.com/MobilityData/gbfs/${commitJson.sha}/systems.csv`;
  const csvResponse = await fetchImpl(url, {
    headers: { "User-Agent": "Open-MapX-gbfs-catalog-pin" },
  });
  if (!csvResponse.ok)
    throw new Error(`MobilityData systems.csv failed: HTTP ${csvResponse.status}`);
  const csv = await csvResponse.text();
  const countryCounts = new Map<string, number>();
  for (const row of parseMobilityDataGbfsCsv(csv)) {
    countryCounts.set(row.countryCode, (countryCounts.get(row.countryCode) ?? 0) + 1);
  }
  return {
    lock: decodeGbfsCatalogLock({
      schemaVersion: 1,
      source: "mobilitydata-gbfs",
      commit: commitJson.sha,
      url,
      sha256: createHash("sha256").update(csv).digest("hex"),
      lockedAt: now().toISOString(),
      lockedBy,
    }),
    countryCounts,
  };
}

/**
 * Replace the lock and the compiled commit together: each is staged first,
 * and if either replacement fails, both are restored.
 */
export function writeGbfsCatalogPin(
  repoRoot: string,
  lock: GbfsCatalogLock,
  operations: { rename?: typeof renameSync } = {},
): void {
  const rename = operations.rename ?? renameSync;
  decodeGbfsCatalogLock(lock);
  const lockPath = join(repoRoot, LOCK_PATH);
  const constantsPath = join(repoRoot, CONSTANTS_PATH);
  const previousConstants = readFileSync(constantsPath, "utf8");
  if (!COMMIT_LITERAL.test(previousConstants)) {
    throw new Error(`${CONSTANTS_PATH} has no MOBILITYDATA_GBFS_CATALOG_COMMIT literal`);
  }
  const previousLock = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
  const files = [
    {
      path: lockPath,
      previous: previousLock,
      next: `${JSON.stringify({ $schema: "./gbfs-catalog.lock.schema.json", ...lock }, null, 2)}\n`,
    },
    {
      path: constantsPath,
      previous: previousConstants,
      next: previousConstants.replace(COMMIT_LITERAL, `$1${lock.commit}$2`),
    },
  ];
  const stagedPath = (path: string) => `${path}.tmp-${process.pid}`;
  const replaced: typeof files = [];
  try {
    for (const file of files) writeFileSync(stagedPath(file.path), file.next, "utf8");
    for (const file of files) {
      rename(stagedPath(file.path), file.path);
      replaced.push(file);
    }
  } catch (error) {
    for (const file of replaced) {
      if (file.previous !== null) writeFileSync(file.path, file.previous, "utf8");
      else if (existsSync(file.path)) unlinkSync(file.path);
    }
    for (const file of files) {
      if (existsSync(stagedPath(file.path))) unlinkSync(stagedPath(file.path));
    }
    throw new Error(
      `GBFS catalog pin update failed; previous files restored: ${(error as Error).message}`,
    );
  }
}

async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    log.err("Refusing to pin non-interactively. Re-run with --yes to skip confirmation.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function resolveLockedBy(): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("git", ["config", "user.email"]);
    const email = stdout.trim();
    if (email) return email;
  } catch {
    // Fall through to the environment fallback.
  }
  return process.env.USER ?? "unknown";
}

export async function main(argv: readonly string[]): Promise<void> {
  let candidate: Awaited<ReturnType<typeof resolveGbfsCandidate>>;
  try {
    candidate = await resolveGbfsCandidate(await resolveLockedBy());
  } catch (error) {
    log.err(
      `GBFS registry candidate failed validation; no files changed: ${(error as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }
  const current = decodeGbfsCatalogLock(
    JSON.parse(readFileSync(join(REPO_ROOT, LOCK_PATH), "utf8")),
  );
  if (current.commit === candidate.lock.commit) {
    log.ok(`Already pinned to MobilityData GBFS ${current.commit.slice(0, 12)} — nothing to do.`);
    return;
  }
  const counts = candidate.countryCounts;
  log.info(`New MobilityData GBFS registry: ${candidate.lock.commit}`);
  log.info(
    `  GBFS systems: ${[...counts.values()].reduce((sum, count) => sum + count, 0)} across ${counts.size} countries; DACH DE=${counts.get("de") ?? 0}, AT=${counts.get("at") ?? 0}, CH=${counts.get("ch") ?? 0}`,
  );
  if (!argv.includes("--yes")) {
    const ok = await promptConfirm("Write this GBFS registry pin? [y/N]");
    if (!ok) {
      log.info("Aborted — no pin files changed.");
      return;
    }
  }
  writeGbfsCatalogPin(REPO_ROOT, candidate.lock);
  log.ok(`Pinned MobilityData GBFS to ${candidate.lock.commit}`);
  log.dim("Run `pnpm check-toolchain-pins` to verify the lock and the compiled commit agree.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2));
}
