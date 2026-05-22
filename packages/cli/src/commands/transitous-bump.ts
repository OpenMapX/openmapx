import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { execa } from "execa";
import {
  parseRefShaPair,
  readTransitousLock,
  type TransitousLock,
  writeTransitousLock,
} from "../../../../services/data-manager/src/transitous-lock";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";

const TRANSITOUS_CATALOG_DIR = ".transitous-catalog";

interface FeedFile {
  sources?: Array<{ name?: string }>;
}

interface FeedDiffSummary {
  addedRegions: string[];
  removedRegions: string[];
  modifiedRegions: string[];
  addedSources: number;
  removedSources: number;
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

function diffFeedFiles(
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
    if (regionChanged) modifiedRegions.push(region);
  }
  for (const region of removedRegions) {
    removedSources += (oldFeeds.get(region)?.sources ?? []).length;
  }
  modifiedRegions.sort();
  return { addedRegions, removedRegions, modifiedRegions, addedSources, removedSources };
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
      "Fetch origin/main of the Transitous catalog, summarize feed changes, and update infra/docker/transitous.lock.json",
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
      const previousSha = existing ? parseRefShaPair(existing.ref).sha : null;

      if (previousSha === newSha) {
        log.ok(`Already pinned to ${options.branch}@${newSha.slice(0, 12)} — nothing to do.`);
        return;
      }

      log.info(`New ref: ${options.branch}@${newSha}`);
      log.info(`New transitland-atlas: ${newSubmoduleSha}`);

      if (previousSha) {
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
        const ok = await promptConfirm(
          "Write this pin to infra/docker/transitous.lock.json? [y/N]",
        );
        if (!ok) {
          log.info("Aborted — no lockfile changes.");
          return;
        }
      }

      const lock: TransitousLock = {
        ref: `${options.branch}@${newSha}`,
        submodules: { "transitland-atlas": newSubmoduleSha },
        lockedAt: new Date().toISOString(),
        lockedBy: await resolveLockedBy(),
        comment:
          "Pinned commit of public-transport/transitous consumed by services/data-manager. Bump via `pnpm openmapx transitous bump`.",
      };
      writeTransitousLock(paths.root, lock);

      log.ok(`Updated ${join("infra", "docker", "transitous.lock.json")}`);
      log.dim("Restart data-manager to pick up the new ref, or wait for next cron sync.");
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
