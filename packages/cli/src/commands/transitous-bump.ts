import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseMobilityDataGbfsCsv } from "@openmapx/transitous-core";
import type { Command } from "commander";
import { execa } from "execa";
import {
  decodeGbfsCatalogLock,
  type GbfsCatalogLock,
  readGbfsCatalogLock,
} from "../../../../services/data-manager/src/gbfs-catalog-lock";
import {
  parseRefShaPair,
  readTransitousLock,
  type TransitousLock,
} from "../../../../services/data-manager/src/transitous-lock";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";

const TRANSITOUS_CATALOG_DIR = ".transitous-catalog";
const MOBILITYDATA_REPO_API = "https://api.github.com/repos/MobilityData/gbfs/commits/master";

export async function resolveGbfsCandidate(
  lockedBy: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<{ lock: GbfsCatalogLock; countryCounts: Map<string, number> }> {
  const commitResponse = await fetchImpl(MOBILITYDATA_REPO_API, {
    headers: { "User-Agent": "openmapx-transitous-bump" },
  });
  if (!commitResponse.ok)
    throw new Error(`MobilityData commit lookup failed: HTTP ${commitResponse.status}`);
  const commitJson = (await commitResponse.json()) as { sha?: unknown };
  if (typeof commitJson.sha !== "string" || !/^[0-9a-f]{40}$/.test(commitJson.sha)) {
    throw new Error("MobilityData commit lookup returned an invalid SHA");
  }
  const url = `https://raw.githubusercontent.com/MobilityData/gbfs/${commitJson.sha}/systems.csv`;
  const csvResponse = await fetchImpl(url, {
    headers: { "User-Agent": "openmapx-transitous-bump" },
  });
  if (!csvResponse.ok)
    throw new Error(`MobilityData systems.csv failed: HTTP ${csvResponse.status}`);
  const csv = await csvResponse.text();
  const countryCounts = new Map<string, number>();
  for (const row of parseMobilityDataGbfsCsv(csv)) {
    countryCounts.set(row.countryCode, (countryCounts.get(row.countryCode) ?? 0) + 1);
  }
  return {
    lock: {
      schemaVersion: 1,
      source: "mobilitydata-gbfs",
      commit: commitJson.sha,
      url,
      sha256: createHash("sha256").update(csv).digest("hex"),
      lockedAt: now().toISOString(),
      lockedBy,
    },
    countryCounts,
  };
}

export function combinedPinsAreCurrent(
  transitous: TransitousLock | null,
  gbfs: GbfsCatalogLock | null,
  transitousSha: string,
  gbfsCommit: string,
): boolean {
  return (
    (transitous ? parseRefShaPair(transitous.ref).sha : null) === transitousSha &&
    gbfs?.commit === gbfsCommit
  );
}

function transitousLockJson(lock: TransitousLock): string {
  return `${JSON.stringify(
    {
      $schema: "./transitous.lock.schema.json",
      ref: lock.ref,
      submodules: lock.submodules,
      lockedAt: lock.lockedAt,
      lockedBy: lock.lockedBy,
      ...(lock.comment ? { comment: lock.comment } : {}),
    },
    null,
    2,
  )}\n`;
}

function gbfsLockJson(lock: GbfsCatalogLock): string {
  decodeGbfsCatalogLock(lock);
  return `${JSON.stringify({ $schema: "./gbfs-catalog.lock.schema.json", ...lock }, null, 2)}\n`;
}

/** Stage and replace the compatible Transitous/MobilityData pin set together. */
export function writeCombinedCatalogLocks(
  repoRoot: string,
  transitous: TransitousLock,
  gbfs: GbfsCatalogLock,
  operations: {
    write?: typeof writeFileSync;
    rename?: typeof renameSync;
    remove?: typeof unlinkSync;
  } = {},
): void {
  const write = operations.write ?? writeFileSync;
  const rename = operations.rename ?? renameSync;
  const remove = operations.remove ?? unlinkSync;
  const transitousPath = join(repoRoot, "infra", "docker", "transitous.lock.json");
  const gbfsPath = join(repoRoot, "infra", "docker", "gbfs-catalog.lock.json");
  const suffix = `.candidate-${process.pid}`;
  const stagedTransitous = `${transitousPath}${suffix}`;
  const stagedGbfs = `${gbfsPath}${suffix}`;
  const previousTransitous = existsSync(transitousPath) ? readFileSync(transitousPath) : null;
  const previousGbfs = existsSync(gbfsPath) ? readFileSync(gbfsPath) : null;
  let transitousReplaced = false;
  let gbfsReplaced = false;
  try {
    write(stagedTransitous, transitousLockJson(transitous), "utf-8");
    write(stagedGbfs, gbfsLockJson(gbfs), "utf-8");
    rename(stagedTransitous, transitousPath);
    transitousReplaced = true;
    rename(stagedGbfs, gbfsPath);
    gbfsReplaced = true;
  } catch (error) {
    if (transitousReplaced) {
      if (previousTransitous) write(transitousPath, previousTransitous);
      else if (existsSync(transitousPath)) remove(transitousPath);
    }
    if (gbfsReplaced) {
      if (previousGbfs) write(gbfsPath, previousGbfs);
      else if (existsSync(gbfsPath)) remove(gbfsPath);
    }
    for (const path of [stagedTransitous, stagedGbfs]) {
      if (existsSync(path)) remove(path);
    }
    throw new Error(
      `Combined catalog lock update failed; previous pins restored: ${(error as Error).message}`,
    );
  }
}

/** Write a reviewable pin-set proposal without mutating active lockfiles. */
export function writeCombinedCatalogLockProposal(
  repoRoot: string,
  transitous: TransitousLock,
  gbfs: GbfsCatalogLock,
): void {
  const transitousPath = join(repoRoot, "infra", "docker", "transitous.lock.proposed.json");
  const gbfsPath = join(repoRoot, "infra", "docker", "gbfs-catalog.lock.proposed.json");
  const suffix = `.candidate-${process.pid}`;
  writeFileSync(`${transitousPath}${suffix}`, transitousLockJson(transitous), "utf-8");
  writeFileSync(`${gbfsPath}${suffix}`, gbfsLockJson(gbfs), "utf-8");
  renameSync(`${transitousPath}${suffix}`, transitousPath);
  renameSync(`${gbfsPath}${suffix}`, gbfsPath);
}

export interface FeedFile {
  sources?: Array<{ name?: string; license?: Record<string, unknown> }>;
}

export interface FeedDiffSummary {
  addedRegions: string[];
  removedRegions: string[];
  modifiedRegions: string[];
  addedSources: number;
  removedSources: number;
  licenseChanges: Array<{ region: string; source: string }>;
}

function gitArgs(catalogDir: string, ...rest: string[]): string[] {
  return ["-c", `safe.directory=${catalogDir}`, "-C", catalogDir, ...rest];
}

async function runGit(catalogDir: string, args: string[]): Promise<string> {
  const result = await execa("git", gitArgs(catalogDir, ...args), { stdio: "pipe" });
  return result.stdout.trim();
}

async function listFeedsAtRevision(
  catalogDir: string,
  sha: string,
): Promise<Map<string, FeedFile>> {
  const out = new Map<string, FeedFile>();
  let listing: string;
  try {
    listing = await runGit(catalogDir, ["ls-tree", "--name-only", `${sha}:feeds`]);
  } catch {
    return out;
  }
  for (const line of listing.split("\n")) {
    const name = line.trim();
    if (!name.endsWith(".json")) continue;
    const region = name.replace(/\.json$/i, "");
    let raw: string;
    try {
      raw = await runGit(catalogDir, ["show", `${sha}:feeds/${name}`]);
    } catch {
      continue;
    }
    try {
      out.set(region, JSON.parse(raw) as FeedFile);
    } catch {
      // Skip malformed feed files — we don't want a single broken JSON file to
      // block a catalog bump on otherwise fine regions.
    }
  }
  return out;
}

export function diffFeedFiles(
  oldFeeds: Map<string, FeedFile>,
  newFeeds: Map<string, FeedFile>,
): FeedDiffSummary {
  const oldRegions = new Set(oldFeeds.keys());
  const newRegions = new Set(newFeeds.keys());
  const addedRegions = [...newRegions].filter((region) => !oldRegions.has(region)).sort();
  const removedRegions = [...oldRegions].filter((region) => !newRegions.has(region)).sort();
  const modifiedRegions: string[] = [];
  let addedSources = 0;
  let removedSources = 0;
  const licenseChanges: FeedDiffSummary["licenseChanges"] = [];

  for (const region of newRegions) {
    if (!oldRegions.has(region)) {
      addedSources += (newFeeds.get(region)?.sources ?? []).length;
      continue;
    }
    const oldNames = new Set(
      (oldFeeds.get(region)?.sources ?? [])
        .map((source) => source.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const newNames = new Set(
      (newFeeds.get(region)?.sources ?? [])
        .map((source) => source.name)
        .filter((name): name is string => typeof name === "string"),
    );
    let regionChanged = false;
    for (const name of newNames) {
      if (!oldNames.has(name)) {
        addedSources++;
        regionChanged = true;
      }
    }
    for (const name of oldNames) {
      if (!newNames.has(name)) {
        removedSources++;
        regionChanged = true;
      }
    }
    const oldByName = new Map(
      (oldFeeds.get(region)?.sources ?? []).flatMap((source) =>
        source.name ? [[source.name, source] as const] : [],
      ),
    );
    for (const source of newFeeds.get(region)?.sources ?? []) {
      if (!source.name || !oldByName.has(source.name)) continue;
      const previous = oldByName.get(source.name);
      if (JSON.stringify(previous?.license ?? null) !== JSON.stringify(source.license ?? null)) {
        licenseChanges.push({ region, source: source.name });
        regionChanged = true;
      }
    }
    if (regionChanged) modifiedRegions.push(region);
  }
  for (const region of removedRegions) {
    removedSources += (oldFeeds.get(region)?.sources ?? []).length;
  }
  modifiedRegions.sort();
  return {
    addedRegions,
    removedRegions,
    modifiedRegions,
    addedSources,
    removedSources,
    licenseChanges: licenseChanges.sort((a, b) =>
      `${a.region}/${a.source}`.localeCompare(`${b.region}/${b.source}`),
    ),
  };
}

function printDiffSummary(summary: FeedDiffSummary): void {
  log.info(
    `  added regions:    ${summary.addedRegions.length}${summary.addedRegions.length > 0 ? `  (${summary.addedRegions.join(", ")})` : ""}`,
  );
  log.info(
    `  removed regions:  ${summary.removedRegions.length}${summary.removedRegions.length > 0 ? `  (${summary.removedRegions.join(", ")})` : ""}`,
  );
  log.info(
    `  modified regions: ${summary.modifiedRegions.length}${summary.modifiedRegions.length > 0 ? `  (${summary.modifiedRegions.join(", ")})` : ""}`,
  );
  log.info(`  added sources:    ${summary.addedSources}`);
  log.info(`  removed sources:  ${summary.removedSources}`);
  log.info(
    `  license changes:  ${summary.licenseChanges.length}${summary.licenseChanges.length > 0 ? `  (${summary.licenseChanges.map((entry) => `${entry.region}/${entry.source}`).join(", ")})` : ""}`,
  );
}

async function readSubmoduleSha(catalogDir: string, ref: string, path: string): Promise<string> {
  // `git ls-tree <ref> <path>` returns a line like:
  //   160000 commit <sha>\t<path>
  // for a submodule entry. We pull that SHA out explicitly because
  // `rev-parse <ref>:<path>` resolves the tree, not the gitlink target.
  const output = await runGit(catalogDir, ["ls-tree", ref, path]);
  const match = output.match(/^\d+\s+commit\s+([0-9a-f]{40})\s/i);
  if (!match) {
    throw new Error(`Could not resolve submodule SHA for "${path}" at ${ref}`);
  }
  return match[1];
}

async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    log.err("Refusing to bump non-interactively. Re-run with --yes to skip confirmation.");
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
    const result = await execa("git", ["config", "user.email"], { stdio: "pipe" });
    const email = result.stdout.trim();
    if (email) return email;
  } catch {
    // ignore — fall through to env var
  }
  return process.env.USER ?? "unknown";
}

export function registerTransitousCommands(program: Command): void {
  const transitous = program.command("transitous").description("Manage the Transitous catalog pin");

  transitous
    .command("bump")
    .description(
      "Fetch upstream pins, summarize feed changes, and write a reviewable inactive-slot proposal",
    )
    .option("--yes", "Skip the interactive confirmation prompt", false)
    .option("--branch <name>", "Branch to track (default: main)", "main")
    .action(async (options: { yes: boolean; branch: string }) => {
      const paths = repoPaths();
      const catalogDir = join(paths.infraDir, "data", TRANSITOUS_CATALOG_DIR);
      if (!existsSync(join(catalogDir, ".git"))) {
        log.err(
          `Transitous catalog not found at ${catalogDir}. Run the data-manager once (e.g. via \`pnpm openmapx data download gtfs\`) so it clones the catalog, then retry.`,
        );
        process.exit(1);
      }

      log.dim(`Fetching origin/${options.branch} in ${catalogDir}...`);
      try {
        await execa("git", gitArgs(catalogDir, "fetch", "origin", options.branch), {
          stdio: "pipe",
        });
      } catch (err) {
        log.err(`git fetch failed: ${(err as Error).message}`);
        process.exit(1);
      }

      const newSha = await runGit(catalogDir, ["rev-parse", `origin/${options.branch}`]);
      const newSubmoduleSha = await readSubmoduleSha(
        catalogDir,
        `origin/${options.branch}`,
        "transitland-atlas",
      );

      const existing = readTransitousLock(paths.root);
      const lockedBy = await resolveLockedBy();
      let gbfsCandidate: Awaited<ReturnType<typeof resolveGbfsCandidate>>;
      try {
        gbfsCandidate = await resolveGbfsCandidate(lockedBy);
      } catch (error) {
        log.err(
          `GBFS registry candidate failed validation; preserving all current pins: ${(error as Error).message}`,
        );
        process.exit(1);
      }
      let existingGbfs: GbfsCatalogLock | null = null;
      try {
        existingGbfs = readGbfsCatalogLock(paths.root);
      } catch {
        // First combined bump creates it after confirmation.
      }
      if (combinedPinsAreCurrent(existing, existingGbfs, newSha, gbfsCandidate.lock.commit)) {
        log.ok(
          `Already pinned to Transitous ${newSha.slice(0, 12)} and GBFS ${gbfsCandidate.lock.commit.slice(0, 12)} — nothing to do.`,
        );
        return;
      }

      log.info(`New ref: ${options.branch}@${newSha}`);
      log.info(`New transitland-atlas: ${newSubmoduleSha}`);
      log.info(`New MobilityData GBFS registry: ${gbfsCandidate.lock.commit}`);
      log.info(
        `  GBFS systems: ${[...gbfsCandidate.countryCounts.values()].reduce((sum, count) => sum + count, 0)} across ${gbfsCandidate.countryCounts.size} countries; DACH DE=${gbfsCandidate.countryCounts.get("de") ?? 0}, AT=${gbfsCandidate.countryCounts.get("at") ?? 0}, CH=${gbfsCandidate.countryCounts.get("ch") ?? 0}`,
      );

      if (existing) {
        const previousSha = parseRefShaPair(existing.ref).sha;
        log.info(`Diff vs current pin ${previousSha.slice(0, 12)}:`);
        const [oldFeeds, newFeeds] = await Promise.all([
          listFeedsAtRevision(catalogDir, previousSha),
          listFeedsAtRevision(catalogDir, newSha),
        ]);
        printDiffSummary(diffFeedFiles(oldFeeds, newFeeds));
      } else {
        log.dim("(no previous pin — printing full feed inventory)");
        const feeds = await listFeedsAtRevision(catalogDir, newSha);
        const sourceCount = [...feeds.values()].reduce(
          (sum, feed) => sum + (feed.sources?.length ?? 0),
          0,
        );
        log.info(`  regions: ${feeds.size}, sources: ${sourceCount}`);
      }

      if (!options.yes) {
        const ok = await promptConfirm("Write this pin set as an inactive-slot proposal? [y/N]");
        if (!ok) {
          log.info("Aborted — no lockfile changes.");
          return;
        }
      }

      const lock: TransitousLock = {
        ref: `${options.branch}@${newSha}`,
        submodules: { "transitland-atlas": newSubmoduleSha },
        lockedAt: new Date().toISOString(),
        lockedBy,
        comment:
          "Pinned commit of public-transport/transitous consumed by services/data-manager. Bump via `pnpm openmapx transitous bump`.",
      };
      writeCombinedCatalogLockProposal(paths.root, lock, gbfsCandidate.lock);

      log.ok(`Proposed Transitous and GBFS catalog lock set under ${join("infra", "docker")}`);
      log.dim("Review diffs and validate an inactive MOTIS slot before activating the proposal.");
    });

  transitous
    .command("show")
    .description("Print the current Transitous lockfile contents")
    .action(() => {
      const paths = repoPaths();
      const lockPath = join(paths.infraDir, "transitous.lock.json");
      if (!existsSync(lockPath)) {
        log.warn(
          "No infra/docker/transitous.lock.json found. Run `pnpm openmapx transitous bump` to create one.",
        );
        return;
      }
      console.log(readFileSync(lockPath, "utf-8"));
    });
}
