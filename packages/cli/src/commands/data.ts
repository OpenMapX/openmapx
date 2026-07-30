import { mkdirSync } from "node:fs";
import { services } from "@openmapx/core/server";
import type { Command } from "commander";
import kleur from "kleur";
import {
  applyDataCleanup,
  collectOfflineDataStatus,
  planDataCleanup,
  pruneDataManagerStateForCleanup,
} from "../lib/data-local";
import {
  OPENMAPX_REGION_ENV,
  resolveOsmRegion,
  resolveOverpassRegion,
  resolveTransitousCountries,
  TRANSITOUS_COUNTRIES_ENV,
} from "../lib/env-defaults";
import { applyGeneratedHardlinks } from "../lib/hardlinks";
import { log, table } from "../lib/output";
import { buildServices, resolveDataBuildServiceId } from "../lib/service-builds";
import { generateTransitousApiKeys } from "../lib/transitous-api-keys";
import { renderComposeForRepo } from "./compose";

const { DataManagerClient } = services;
type DatasetMetadata = services.DatasetMetadata;

const DEFAULT_DM_URL = process.env.DATA_MANAGER_URL ?? "http://localhost:4000";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface ProgressRenderer {
  update: (bytes: number, total: number | undefined, startedAtMs: number) => void;
  done: () => void;
}

/**
 * Single-line progress bar that rewrites itself in-place via `\r`. Falls back
 * to plain text (and never repeats a line) when stdout isn't a TTY — useful
 * for CI logs and `tee`/pipe redirections.
 */
function progressRenderer(): ProgressRenderer {
  const isTty = process.stdout.isTTY === true;
  const barWidth = 24;
  let lastLine = "";

  const write = (line: string) => {
    if (!isTty) {
      if (line === lastLine) return;
      process.stdout.write(`${line}\n`);
      lastLine = line;
      return;
    }
    process.stdout.write(`\r${" ".repeat(lastLine.length)}\r${line}`);
    lastLine = line;
  };

  return {
    update(bytes, total, startedAtMs) {
      const elapsed = Date.now() - startedAtMs;
      const rate = elapsed > 0 ? bytes / (elapsed / 1000) : 0;
      const rateStr = `${formatBytes(rate)}/s`;
      if (total && total > 0) {
        const pct = Math.min(100, (bytes / total) * 100);
        const filled = Math.round((pct / 100) * barWidth);
        const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
        const etaMs = rate > 0 ? ((total - bytes) / rate) * 1000 : 0;
        const etaStr = rate > 0 ? ` · ETA ${formatDuration(etaMs)}` : "";
        write(
          `${kleur.cyan(bar)} ${pct.toFixed(1).padStart(5)}%  ${formatBytes(bytes)} / ${formatBytes(total)}  ${rateStr}${etaStr}`,
        );
      } else {
        write(`${kleur.dim("downloading")}  ${formatBytes(bytes)}  ${rateStr}`);
      }
    },
    done() {
      if (isTty && lastLine) process.stdout.write("\n");
      lastLine = "";
    },
  };
}

function printDataManagerStatusTable(datasets: DatasetMetadata[]): void {
  if (datasets.length === 0) {
    log.info("(no datasets downloaded yet)");
    return;
  }
  console.log(
    table(
      [
        { key: "type", header: "Type" },
        { key: "id", header: "ID" },
        { key: "size", header: "Size" },
        { key: "downloadedAt", header: "Downloaded" },
      ],
      datasets.map((d) => ({
        type: d.type,
        id: d.id,
        size: `${(d.sizeBytes / 1e9).toFixed(2)} GB`,
        downloadedAt: d.downloadedAt,
      })),
    ),
  );
}

function printOfflineStatus(): void {
  const snapshot = collectOfflineDataStatus();

  log.info(`Offline status scan from ${snapshot.dataRoot}`);

  if (snapshot.totalFiles === 0) {
    log.info("(no local data found)");
    return;
  }

  console.log("\nOSM PBF:");
  if (snapshot.osmPbfFiles.length === 0) {
    console.log("  (none)");
  } else {
    for (const file of snapshot.osmPbfFiles) {
      const planetHint = file.sizeBytes > 50_000_000_000 ? "  [planet-scale]" : "";
      console.log(`  ${file.name}  ${formatBytes(file.sizeBytes)}${planetHint}`);
    }
  }

  console.log("\nGTFS:");
  if (snapshot.gtfsZipFiles.length === 0) {
    console.log("  (none)");
  } else {
    const totalGtfs = snapshot.gtfsZipFiles.reduce((sum, feed) => sum + feed.sizeBytes, 0);
    console.log(`  ${snapshot.gtfsZipFiles.length} feed(s), ${formatBytes(totalGtfs)} total`);
    for (const feed of snapshot.gtfsZipFiles.slice(0, 10)) {
      console.log(`  ${feed.name}  ${formatBytes(feed.sizeBytes)}`);
    }
    if (snapshot.gtfsZipFiles.length > 10) {
      console.log(`  ... and ${snapshot.gtfsZipFiles.length - 10} more`);
    }
  }

  console.log("\nDirectory Usage:");
  if (snapshot.directories.length === 0) {
    console.log("  (no data directories)");
  } else {
    console.log(
      table(
        [
          { key: "name", header: "Dir" },
          { key: "files", header: "Files" },
          { key: "size", header: "Size" },
        ],
        snapshot.directories.map((dir) => ({
          name: `${dir.name}/`,
          files: String(dir.files),
          size: formatBytes(dir.sizeBytes),
        })),
      ),
    );
  }

  console.log(`\nTotal: ${snapshot.totalFiles} file(s), ${formatBytes(snapshot.totalBytes)}`);
}

async function runOsmDownload(
  client: services.DataManagerClient,
  region: string | undefined,
): Promise<string> {
  const resolvedRegion = resolveOsmRegion(region);
  if (resolvedRegion.sourceEnv) {
    log.dim(`using region "${resolvedRegion.value}" from $${resolvedRegion.sourceEnv}`);
  }
  if (!resolvedRegion.value) {
    throw new Error(
      `region required (e.g. 'planet', 'europe/germany') or set $${OPENMAPX_REGION_ENV}`,
    );
  }

  const started = Date.now();
  const render = progressRenderer();
  const r = await client.downloadOsm(resolvedRegion.value, {
    onProgress: (bytes, total) => render.update(bytes, total, started),
  });
  render.done();
  log.ok(`Downloaded ${resolvedRegion.value} (${(r.sizeBytes / 1e9).toFixed(2)} GB) → ${r.path}`);
  return resolvedRegion.value;
}

async function runTransitSync(
  client: services.DataManagerClient,
  options: { countries?: string },
): Promise<string> {
  const resolvedCountries = resolveTransitousCountries(options.countries);
  if (resolvedCountries.sourceEnv) {
    log.dim(
      `using GTFS country filter from $${resolvedCountries.sourceEnv}: ${resolvedCountries.values.join(", ")}`,
    );
  }

  const result = await client.syncTransit({
    countries: resolvedCountries.values,
    triggeredBy: "openmapx-cli",
  });
  log.ok(`Transit sync started: jobId=${result.jobId}`);
  return result.jobId;
}

async function runStyleDownload(client: services.DataManagerClient): Promise<void> {
  await client.downloadStyle();
  log.ok("Downloaded styles + fonts + sprites");
}

async function renderAndApplyHardlinks(): Promise<void> {
  const rendered = await renderComposeForRepo({ domain: process.env.DOMAIN ?? "localhost" });
  for (const warning of rendered.selectionWarnings) log.warn(warning);
  const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true });
  log.ok(
    `Applied hardlinks: ${linked.linked} linked, ${linked.skipped} already linked, ${linked.pruned} stale file${linked.pruned === 1 ? "" : "s"} pruned`,
  );
}

function dataManagerHint(): void {
  log.dim(`(is data-manager running? expected at ${DEFAULT_DM_URL})`);
}

export function registerDataCommands(program: Command): void {
  const data = program.command("data").description("Manage source data");

  data
    .command("download <kind> [region]")
    .description("Download source data (osm <region> | style) or start a transactional GTFS sync")
    .option(
      "--countries <list>",
      `Comma-separated GTFS country codes (gtfs only; default: $${TRANSITOUS_COUNTRIES_ENV})`,
    )
    .action(async (kind: string, region: string | undefined, options: { countries?: string }) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        if (kind === "osm") {
          await runOsmDownload(client, region);
        } else if (kind === "gtfs") {
          await runTransitSync(client, options);
        } else if (kind === "style") {
          await runStyleDownload(client);
        } else {
          log.err(`Unknown kind: ${kind} (use osm | gtfs | style)`);
          process.exit(1);
        }
      } catch (err) {
        log.err(`download failed: ${(err as Error).message}`);
        if (!(err as Error).message.startsWith("region required")) {
          dataManagerHint();
        }
        process.exit(1);
      }
    });

  data
    .command("build <kind> [region]")
    .description(
      "Build prepared artifacts from downloaded data (compatibility alias for `services build`; kind: motis | osrm | otp | pelias | tiles)",
    )
    .action(async (kind: string, region: string | undefined) => {
      try {
        const serviceId = resolveDataBuildServiceId(kind);
        if (!serviceId) {
          log.err(`Unknown kind: ${kind} (use: motis | osrm | otp | pelias | tiles)`);
          process.exit(1);
        }
        const result = await buildServices({
          mode: "explicit",
          serviceIds: [serviceId],
          region,
        });
        if (result.completedIds.length === 0) return;
        await renderAndApplyHardlinks();
      } catch (err) {
        log.err(`build failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  data
    .command("update [region]")
    .description(
      "Run the full data refresh sequence: download OSM + GTFS + style, build all prepared artifacts, then render compose and refresh hardlinks",
    )
    .option(
      "--countries <list>",
      `Comma-separated GTFS country codes (default: $${TRANSITOUS_COUNTRIES_ENV})`,
    )
    .option("--fail-fast", "Stop build-all after the first build failure")
    .action(
      async (region: string | undefined, options: { countries?: string; failFast?: boolean }) => {
        const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
        let resolvedRegion: string;
        try {
          resolvedRegion = await runOsmDownload(client, region);
          await runTransitSync(client, { countries: options.countries });
          await runStyleDownload(client);
        } catch (err) {
          log.err(`update failed: ${(err as Error).message}`);
          if (!(err as Error).message.startsWith("region required")) {
            dataManagerHint();
          }
          process.exit(1);
        }

        try {
          const buildResult = await buildServices({
            mode: "all",
            region: resolvedRegion,
            continueOnError: options.failFast !== true,
          });

          await renderAndApplyHardlinks();

          if (buildResult.failures.length > 0) {
            log.err(
              `update completed with ${buildResult.failures.length} build failure${buildResult.failures.length === 1 ? "" : "s"}`,
            );
            process.exit(1);
          }

          log.ok("Update complete");
        } catch (err) {
          log.err(`update failed: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  data
    .command("convert <kind> [region]")
    .description(
      "Derive a secondary format from an existing download (kind: overpass — converts OSM PBF → OSM BZ2 for Overpass)",
    )
    .action(async (kind: string, region: string | undefined) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        if (kind === "overpass") {
          const resolvedRegion = resolveOverpassRegion(region);
          if (resolvedRegion.sourceEnv) {
            log.dim(`using region "${resolvedRegion.value}" from $${resolvedRegion.sourceEnv}`);
          }
          const started = Date.now();
          const render = progressRenderer();
          const r = await client.convertOverpass({
            region: resolvedRegion.value,
            onProgress: (bytes, total) => render.update(bytes, total, started),
          });
          render.done();
          log.ok(`Converted → ${r.path} (${(r.sizeBytes / 1e9).toFixed(2)} GB)`);
        } else {
          log.err(`Unknown kind: ${kind} (use: overpass)`);
          process.exit(1);
        }
      } catch (err) {
        log.err(`convert failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  data
    .command("link")
    .description(
      "Re-render the compose plan from the current service selection, then apply + prune the hardlink plan (keeps consumer dirs in sync with producer data)",
    )
    .action(async () => {
      try {
        // Always render first so the plan file reflects the current
        // service-selection. Running against a stale plan silently links
        // dirs the operator no longer wants.
        const rendered = await renderComposeForRepo({ domain: process.env.DOMAIN ?? "localhost" });
        for (const warning of rendered.selectionWarnings) log.warn(warning);
        const result = await applyGeneratedHardlinks({ prune: true, requirePlan: true });
        log.ok(
          `Linked ${result.linked} files (${result.skipped} already linked, ${result.pruned} stale file${result.pruned === 1 ? "" : "s"} pruned)`,
        );
      } catch (err) {
        log.err(`link failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  data
    .command("sync")
    .description("Start a transactional transit-source sync")
    .option(
      "--countries <list>",
      `Comma-separated country codes (default: $${TRANSITOUS_COUNTRIES_ENV})`,
    )
    .action(async (options: { countries?: string }) => {
      try {
        await runTransitSync(new DataManagerClient({ baseUrl: DEFAULT_DM_URL }), options);
      } catch (err) {
        log.err(`sync failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  const source = data.command("source").description("Manage desired transit source state");

  source
    .command("list")
    .description("List requested and active transit sources")
    .action(async () => {
      try {
        const result = await new DataManagerClient({ baseUrl: DEFAULT_DM_URL }).transitSources({
          limit: 500,
        });
        console.log(
          table(
            [
              { key: "id", header: "Source" },
              { key: "origin", header: "Origin" },
              { key: "region", header: "Region" },
              { key: "state", header: "State" },
            ],
            result.sources.map((entry) => ({
              id: entry.id,
              origin: entry.origin,
              region: entry.region,
              state: `${entry.requested ? "requested" : "disabled"}/${entry.active ? "active" : "inactive"} (${entry.lifecycle})`,
            })),
          ),
        );
      } catch (err) {
        log.err(`source list failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  source
    .command("add <url>")
    .description("Add an operator source and start a transactional sync")
    .requiredOption("--name <name>", "Safe display name")
    .requiredOption("--region <region>", "Source region (for example de-be)")
    .requiredOption("--attribution <text>", "Required attribution text")
    .option("--license-spdx <id>", "SPDX license identifier")
    .option("--license-url <url>", "License URL")
    .action(
      async (
        url: string,
        options: {
          name: string;
          region: string;
          attribution: string;
          licenseSpdx?: string;
          licenseUrl?: string;
        },
      ) => {
        if (!options.licenseSpdx && !options.licenseUrl) {
          log.err("source add requires --license-spdx or --license-url");
          process.exit(1);
        }
        try {
          const result = await new DataManagerClient({ baseUrl: DEFAULT_DM_URL }).addTransitSource({
            url,
            name: options.name,
            region: options.region,
            license: {
              attribution: options.attribution,
              ...(options.licenseSpdx ? { spdxIdentifier: options.licenseSpdx } : {}),
              ...(options.licenseUrl ? { url: options.licenseUrl } : {}),
            },
          });
          log.ok(`Source ${result.sourceId} queued: jobId=${result.jobId}`);
        } catch (err) {
          log.err(`source add failed: ${(err as Error).message}`);
          dataManagerHint();
          process.exit(1);
        }
      },
    );

  source
    .command("remove <sourceId>")
    .description("Disable a desired source and start a transactional sync")
    .action(async (sourceId: string) => {
      try {
        const result = await new DataManagerClient({ baseUrl: DEFAULT_DM_URL }).removeTransitSource(
          sourceId,
        );
        log.ok(`Source ${result.sourceId} removal queued: jobId=${result.jobId}`);
      } catch (err) {
        log.err(`source remove failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  source
    .command("enable <sourceId>")
    .description("Enable a catalog source and start a transactional sync")
    .action(async (sourceId: string) => {
      try {
        const result = await new DataManagerClient({ baseUrl: DEFAULT_DM_URL }).enableTransitSource(
          sourceId,
        );
        log.ok(`Source ${result.sourceId} enable queued: jobId=${result.jobId}`);
      } catch (err) {
        log.err(`source enable failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  data
    .command("clean <target>")
    .description(
      "Remove local data for one data type alias (e.g. osm, gtfs, style, osrm-graph) or all",
    )
    .action(async (target: string) => {
      try {
        const plan = await planDataCleanup(target);
        const statePrune = pruneDataManagerStateForCleanup(plan);
        const result = applyDataCleanup(plan.paths);
        const shouldReloadDatasets = statePrune.updated || (plan.all && result.removedPaths > 0);

        if (plan.all) {
          mkdirSync(plan.dataRoot, { recursive: true });
        }

        if (result.removedPaths === 0 && !statePrune.updated) {
          log.info(`Nothing to clean for ${target}`);
          return;
        }

        if (result.removedPaths > 0) {
          const label = plan.all ? "all local data" : plan.normalizedTypes.join(", ");
          log.ok(
            `Cleaned ${label}: removed ${result.removedPaths} path(s), ${result.removedFiles} file(s), ${formatBytes(result.removedBytes)}`,
          );
        } else {
          log.ok(`No files removed for ${target}; pruned stale dataset metadata`);
        }

        if (result.removedPaths > 0) {
          for (const path of plan.paths.slice(0, 6)) {
            log.dim(`removed ${path}`);
          }
          if (plan.paths.length > 6) {
            log.dim(`... plus ${plan.paths.length - 6} more path(s)`);
          }
        }
        if (shouldReloadDatasets) {
          try {
            const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
            const reloaded = await client.reloadDatasets();
            log.dim(
              `Reloaded data-manager dataset cache (${reloaded.datasets} dataset${reloaded.datasets === 1 ? "" : "s"})`,
            );
          } catch {
            log.dim(
              "Local datasets were cleaned. If data-manager is running, restart it to refresh in-memory /datasets.",
            );
          }
        }
        if (statePrune.updated) {
          log.dim(
            `Pruned ${statePrune.removedDatasets} dataset entr${statePrune.removedDatasets === 1 ? "y" : "ies"} from ${statePrune.statePath}`,
          );
        }
      } catch (err) {
        log.err(`clean failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  data
    .command("overture-sync [region]")
    .description("Atomically refresh Overture places and rebuild regional OSM links")
    .action(async (region: string | undefined) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Refreshing Overture places for "${resolvedRegion}"…`);
        const result = await client.syncOverture(resolvedRegion, {
          onProgress: (msg) => log.dim(msg),
        });
        if (!result.ok) {
          log.err(`overture-sync failed: ${result.message ?? "unknown error"}`);
          process.exit(1);
        }
        log.ok(`Overture ${result.release ?? "release"} active for "${resolvedRegion}"`);
        if (result.conflation === "failed" || result.conflation === "waiting_for_osm") {
          log.warn(
            `OSM link rebuild is ${result.conflation.replaceAll("_", " ")} and will retry independently` +
              (result.conflationError ? `: ${result.conflationError}` : ""),
          );
        } else {
          log.ok(`${result.linked ?? 0} OSM↔Overture links active`);
        }
      } catch (err) {
        log.err(`overture-sync failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  data
    .command("overture-pull [region]")
    .description("Pull Overture Maps places parquet for a region from S3")
    .action(async (region: string | undefined) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Pulling Overture places for "${resolvedRegion}"…`);
        const result = await client.pullOverture(resolvedRegion, {
          onProgress: (msg) => log.dim(msg),
        });
        if (!result.ok) {
          log.err(`overture-pull failed: ${result.message ?? "unknown error"}`);
          process.exit(1);
        }
        log.ok(`Overture pull complete for "${resolvedRegion}"`);
      } catch (err) {
        log.err(`overture-pull failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  data
    .command("overture-ingest [region]")
    .description("Ingest Overture places parquet into PostGIS for a region")
    .action(async (region: string | undefined) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Ingesting Overture places for "${resolvedRegion}"…`);
        const result = await client.ingestOverture(resolvedRegion, {
          onProgress: (msg) => log.dim(msg),
        });
        if (!result.ok) {
          log.err(`overture-ingest failed: ${result.message ?? "unknown error"}`);
          process.exit(1);
        }
        log.ok(`Overture ingest complete for "${resolvedRegion}"`);
      } catch (err) {
        log.err(`overture-ingest failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  data
    .command("overture-conflate [region]")
    .description("Resume the durable OSM extraction and Overture link rebuild")
    .option("--restart", "Discard saved phases and restart from OSM extraction")
    .action(async (region: string | undefined, options: { restart?: boolean }) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Running Overture conflation for "${resolvedRegion}"…`);
        const result = await client.conflateOverture(resolvedRegion, {
          restart: options.restart,
          onProgress: (msg) => log.dim(msg),
        });
        if (!result.ok) {
          log.err(
            `overture-conflate failed: ${result.message ?? result.status ?? "unknown error"}`,
          );
          process.exit(1);
        }
        const linked = result.linked ?? 0;
        log.ok(
          `Overture conflation complete: ${linked} link${linked === 1 ? "" : "s"} written` +
            (result.extracted !== undefined && result.candidates !== undefined
              ? ` from ${result.extracted} OSM POIs and ${result.candidates} accepted edges`
              : ""),
        );
      } catch (err) {
        log.err(`overture-conflate failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  data
    .command("overture-status")
    .description("Show the installed Overture release and durable conflation phase")
    .action(async () => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        const result = await client.overtureStatus();
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        log.err(`overture-status failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  data
    .command("overture-extract [region]")
    .description("Extract OSM POIs from the local PBF and write them to overture_places.osm_pois")
    .action(async (region: string | undefined) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Extracting OSM POIs for "${resolvedRegion}"…`);
        const result = await client.extractOverture(resolvedRegion, {
          onProgress: (msg) => log.dim(msg),
        });
        if (!result.ok) {
          log.err(`overture-extract failed: ${result.message ?? "unknown error"}`);
          process.exit(1);
        }
        log.ok(`OSM POI extraction complete for "${resolvedRegion}"`);
      } catch (err) {
        log.err(`overture-extract failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  data
    .command("generate-api-keys")
    .description(
      "Generate Transitous API-key template at services/motis/tools/transitous/api-keys.json",
    )
    .option("--repo-url <url>", "Override Transitous catalog git URL")
    .option(
      "--output <path>",
      "Override output path (default: services/motis/tools/transitous/api-keys.json)",
    )
    .action(async (options: { repoUrl?: string; output?: string }) => {
      try {
        log.dim("Syncing Transitous catalog and scanning feeds that require API keys...");
        const result = await generateTransitousApiKeys({
          transitousRepoUrl: options.repoUrl,
          outputPath: options.output,
        });
        const preserved =
          result.preservedCount > 0
            ? ` (${result.preservedCount} existing value${result.preservedCount === 1 ? "" : "s"} preserved)`
            : "";
        log.ok(
          `Generated ${result.outputPath} with ${result.requiredCount} API-key slot${result.requiredCount === 1 ? "" : "s"}${preserved}`,
        );
        if (result.droppedCount > 0) {
          log.warn(
            `Dropped ${result.droppedCount} stale key${result.droppedCount === 1 ? "" : "s"} no longer required by the current Transitous catalog`,
          );
        }
        log.dim("Fill in missing values, then run: openmapx data sync");
      } catch (err) {
        log.err(`generate-api-keys failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  data
    .command("status")
    .description("Show downloaded datasets and sizes")
    .option("--offline", "Scan infra/docker/data directly instead of querying data-manager")
    .action(async (options: { offline?: boolean }) => {
      if (options.offline) {
        printOfflineStatus();
        return;
      }

      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        const datasets = await client.datasets();
        printDataManagerStatusTable(datasets);
      } catch (err) {
        log.warn(
          `status API unavailable (${(err as Error).message}); falling back to filesystem scan`,
        );
        printOfflineStatus();
      }
    });
}
