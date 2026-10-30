import type { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { readCatalogPinSet } from "@openmapx/core/catalog-pins";
import type { GbfsCatalogLock, TransitousLock } from "@openmapx/core/catalog-pins/types";
import { transitBumpResultSchema } from "@openmapx/core/data-manager-contracts";
import * as dm from "@openmapx/core/data-manager-sdk";
import {
  diffCatalogFeeds,
  parseRefShaPair,
  resolveGbfsCatalogCandidate,
} from "@openmapx/transitous-core";
import type { Command } from "commander";
import { dataManagerUrl } from "../lib/data-manager-url";
import { cliAcquisitionOptions, constrainCliDataManagerTransport } from "../lib/execution-deadline";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";

export const resolveGbfsCandidate = resolveGbfsCatalogCandidate;

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
  void repoRoot;
  void transitous;
  void gbfs;
  void operations;
  throw new Error("Catalog pin activation requires validated paired approval");
}

/** Write a reviewable pin-set proposal without mutating active lockfiles. */
export function writeCombinedCatalogLockProposal(
  repoRoot: string,
  transitous: TransitousLock,
  gbfs: GbfsCatalogLock,
): void {
  void repoRoot;
  void transitous;
  void gbfs;
  throw new Error("Catalog proposals require the installed paired review workflow");
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

export function diffFeedFiles(
  oldFeeds: Map<string, FeedFile>,
  newFeeds: Map<string, FeedFile>,
): FeedDiffSummary {
  return diffCatalogFeeds(oldFeeds, newFeeds);
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

export async function proposeReviewedCatalog(branch: string) {
  const transport = constrainCliDataManagerTransport(
    dm.createDataManagerTransport({
      ...cliAcquisitionOptions(),
      baseUrl: dataManagerUrl(),
      authToken: process.env.DATA_MANAGER_AUTH_TOKEN?.trim(),
    }),
  );
  return transitBumpResultSchema.parse(
    dm.unwrapDataManagerResponse(await dm.proposeTransitBump({ branch }, { transport })),
  );
}

export function registerTransitousCommands(program: Command): void {
  const transitous = program.command("transitous").description("Manage the Transitous catalog pin");

  transitous
    .command("bump")
    .description("Create a paired Transitous/GBFS proposal through the installed Data Manager")
    .option("--yes", "Skip the interactive confirmation prompt", false)
    .option("--branch <name>", "Branch to track (default: main)", "main")
    .action(async (options: { yes: boolean; branch: string }) => {
      if (
        !options.yes &&
        !(await promptConfirm("Create a paired catalog proposal for review? [y/N]"))
      )
        return;
      const proposal = await proposeReviewedCatalog(options.branch);
      if (!proposal.unchanged) {
        log.ok(`Proposal created: ${proposal.proposalId}`);
        log.info(`Transitous: ${proposal.ref}`);
        log.dim(
          "Review the complete Transitous/GBFS diff in Admin → Transit, then validate the inactive MOTIS slot before activation.",
        );
      }
    });

  transitous
    .command("show")
    .description("Print the active paired Transitous/GBFS pin generation")
    .action(() => {
      const paths = repoPaths();
      const pins = readCatalogPinSet(paths.root);
      if (!pins) {
        log.warn("Paired catalog pins are not initialized; run the managed bump workflow");
        return;
      }
      console.log(JSON.stringify(pins, null, 2));
    });
}
