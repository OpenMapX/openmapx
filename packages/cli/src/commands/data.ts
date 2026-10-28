import { mkdirSync } from "node:fs";
import type { DatasetMetadata } from "@openmapx/core/data-manager-contracts";
import * as dm from "@openmapx/core/data-manager-sdk";
import type { Command } from "commander";
import {
  BUILD_ARTIFACTS,
  buildArtifactSpec,
  exportBuildBundle,
  importBuildBundle,
} from "../lib/build-artifacts";
import { completeCliCommand } from "../lib/control-context";
import { runCliDataStep } from "../lib/data-execution";
import {
  applyDataCleanup,
  collectOfflineDataStatus,
  planDataCleanup,
  pruneDataManagerStateForCleanup,
} from "../lib/data-local";
import { dataManagerUrl } from "../lib/data-manager-url";
import { runCliDataUpdate } from "../lib/data-update-command";
import { runningComposeServices } from "../lib/docker";
import {
  OPENMAPX_REGION_ENV,
  resolveOsmRegion,
  resolveOverpassRegion,
  resolveTransitousCountries,
  TRANSITOUS_COUNTRIES_ENV,
} from "../lib/env-defaults";
import { cliAcquisitionOptions, constrainCliDataManagerTransport } from "../lib/execution-deadline";
import { applyGeneratedHardlinks } from "../lib/hardlinks";
import { log, routeLogsToStderr, table } from "../lib/output";
import { buildServices, resolveDataBuildServiceId } from "../lib/service-builds";
import { generateTransitousApiKeys } from "../lib/transitous-api-keys";
import { renderComposeForRepo } from "./compose";

function createCliTransport() {
  return constrainCliDataManagerTransport(
    dm.createDataManagerTransport({
      ...cliAcquisitionOptions(),
      baseUrl: dataManagerUrl(),
      authToken: process.env.DATA_MANAGER_AUTH_TOKEN?.trim(),
    }),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
  transport: ReturnType<typeof createCliTransport>,
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

  const status = await runCliDataStep(
    { kind: "download-osm", region: resolvedRegion.value },
    transport,
  );
  if (status.result?.kind !== "download-osm") throw Error("OSM execution result is unavailable");
  log.ok(
    `Downloaded ${resolvedRegion.value} (${(status.result.sizeBytes / 1e9).toFixed(2)} GB); execution ${status.id}`,
  );
  return resolvedRegion.value;
}

async function runTransitSync(
  transport: ReturnType<typeof createCliTransport>,
  options: { countries?: string },
): Promise<string> {
  const resolvedCountries = resolveTransitousCountries(options.countries);
  if (resolvedCountries.sourceEnv) {
    log.dim(
      `using GTFS country filter from $${resolvedCountries.sourceEnv}: ${resolvedCountries.values.join(", ")}`,
    );
  }

  const result = dm.unwrapDataManagerResponse(
    await dm.syncTransit(
      {
        countries: resolvedCountries.values,
        triggeredBy: "openmapx-cli",
      },
      { transport },
    ),
  );
  log.info(
    `Transit sync queued: ${result.jobId}; inspect this execution in Activity or GET /executions/${result.jobId}`,
  );
  return result.jobId;
}

async function runFontDownload(transport: ReturnType<typeof createCliTransport>): Promise<void> {
  await runCliDataStep({ kind: "download-fonts" }, transport);
  log.ok("Downloaded map glyphs");
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
  log.dim(`(is data-manager running? expected at ${dataManagerUrl()})`);
}

export function registerDataCommands(program: Command): void {
  const data = program.command("data").description("Manage source data");

  data
    .command("download <kind> [region]")
    .description("Download source data (osm <region> | fonts) or start a transactional GTFS sync")
    .option(
      "--countries <list>",
      `Comma-separated GTFS country codes (gtfs only; default: $${TRANSITOUS_COUNTRIES_ENV})`,
    )
    .action(async (kind: string, region: string | undefined, options: { countries?: string }) => {
      const transport = createCliTransport();
      try {
        if (kind === "osm") {
          await runOsmDownload(transport, region);
        } else if (kind === "gtfs") {
          await runTransitSync(transport, options);
        } else if (kind === "fonts") {
          await runFontDownload(transport);
        } else {
          log.err(`Unknown kind: ${kind} (use osm | gtfs | fonts)`);
          completeCliCommand(1);
        }
      } catch (err) {
        log.err(`download failed: ${(err as Error).message}`);
        if (!(err as Error).message.startsWith("region required")) {
          dataManagerHint();
        }
        completeCliCommand(1);
      }
    });

  data
    .command("build <kind> [region]")
    .description(
      "Build prepared artifacts from downloaded data (compatibility alias for `services build`; kind: motis | osrm | otp | pelias | tileserver)",
    )
    .action(async (kind: string, region: string | undefined) => {
      try {
        const serviceId = resolveDataBuildServiceId(kind);
        if (!serviceId) {
          log.err(`Unknown kind: ${kind} (use: motis | osrm | otp | pelias | tileserver)`);
          completeCliCommand(1);
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
        completeCliCommand(1);
      }
    });

  data
    .command("export <service> <bundle>")
    .description(
      `Write a service's built artifact and a checksummed manifest as a tar bundle for another host (\`-\` streams to stdout; service: ${Object.keys(BUILD_ARTIFACTS).join(" | ")})`,
    )
    .action(async (serviceId: string, bundle: string) => {
      if (bundle === "-") routeLogsToStderr();
      try {
        const running = await runningComposeServices(buildArtifactSpec(serviceId).consumers);
        if (running.length > 0) {
          throw new Error(
            `${running.join(", ")} ${running.length === 1 ? "is" : "are"} running and may be writing the artifact; stop first with \`openmapx services stop ${running.join(" ")}\``,
          );
        }
        log.dim(`Hashing ${serviceId} artifact…`);
        const manifest = await exportBuildBundle({ serviceId, bundle });
        const bytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
        log.ok(
          `Exported ${serviceId} (${manifest.files.length} files, ${formatBytes(bytes)}, region ${manifest.region ?? "unknown"}) → ${bundle === "-" ? "stdout" : bundle}`,
        );
      } catch (err) {
        log.err(`export failed: ${(err as Error).message}`);
        completeCliCommand(1);
      }
    });

  data
    .command("import <bundle>")
    .description(
      "Verify a bundle written by `data export` (`-` reads stdin), check it matches this host's runtime images, swap it in, then render and link",
    )
    .action(async (bundle: string) => {
      let manifest: Awaited<ReturnType<typeof importBuildBundle>>;
      try {
        manifest = await importBuildBundle({ bundle, runningServices: runningComposeServices });
      } catch (err) {
        log.err(`import failed: ${(err as Error).message}`);
        completeCliCommand(1);
      }
      log.ok(
        `Imported ${manifest.service} (${manifest.files.length} files, built ${manifest.builtAt}${manifest.revision ? ` at ${manifest.revision.slice(0, 12)}` : ""})`,
      );
      try {
        await renderAndApplyHardlinks();
      } catch (err) {
        log.err(
          `The artifact is in place, but rendering and linking failed: ${(err as Error).message}. Fix that, then run \`openmapx data link\`.`,
        );
        completeCliCommand(1);
      }
      log.info(
        `Start the consumers with \`openmapx services start ${buildArtifactSpec(manifest.service).consumers.join(" ")}\``,
      );
    });

  data
    .command("update [region]")
    .description(
      "Run the full data refresh sequence: download OSM + GTFS + fonts, build all prepared artifacts, then render compose and refresh hardlinks",
    )
    .option(
      "--countries <list>",
      `Comma-separated GTFS country codes (default: $${TRANSITOUS_COUNTRIES_ENV})`,
    )
    .option("--fail-fast", "Stop build-all after the first build failure")
    .action(
      async (region: string | undefined, options: { countries?: string; failFast?: boolean }) => {
        try {
          const receipt = await runCliDataUpdate({
            region,
            countries: resolveTransitousCountries(options.countries).values,
            failFast: options.failFast === true,
            transport: createCliTransport(),
          });
          if (receipt.phase === "complete") log.ok("Update complete");
          else log.info("Source data complete; preparing graph builds");
        } catch (error) {
          log.err(`update failed: ${(error as Error).message}`);
          completeCliCommand(1);
        }
      },
    );

  data
    .command("convert <kind> [region]")
    .description(
      "Derive a secondary format from an existing download (kind: overpass — converts OSM PBF → OSM BZ2 for Overpass)",
    )
    .action(async (kind: string, region: string | undefined) => {
      const transport = createCliTransport();
      try {
        if (kind === "overpass") {
          const resolvedRegion = resolveOverpassRegion(region);
          if (resolvedRegion.sourceEnv) {
            log.dim(`using region "${resolvedRegion.value}" from $${resolvedRegion.sourceEnv}`);
          }
          if (!resolvedRegion.value)
            throw Error("Overpass conversion requires a configured region");
          const status = await runCliDataStep(
            { kind: "convert-overpass", region: resolvedRegion.value },
            transport,
          );
          if (status.result?.kind !== "convert-overpass")
            throw Error("Conversion execution result is unavailable");
          log.ok(
            `Converted ${(status.result.sizeBytes / 1e9).toFixed(2)} GB; execution ${status.id}`,
          );
        } else {
          log.err(`Unknown kind: ${kind} (use: overpass)`);
          completeCliCommand(1);
        }
      } catch (err) {
        log.err(`convert failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
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
        completeCliCommand(1);
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
        await runTransitSync(createCliTransport(), options);
      } catch (err) {
        log.err(`sync failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  const searchIndex = data
    .command("search-index")
    .description("Build and inspect the local OSM alias/acronym search index");

  searchIndex
    .command("build [region]")
    .description(`Build the OSM search index (region defaults to $${OPENMAPX_REGION_ENV})`)
    .action(async (region: string | undefined) => {
      const resolvedRegion = resolveOsmRegion(region);
      if (resolvedRegion.sourceEnv) {
        log.dim(`using region "${resolvedRegion.value}" from $${resolvedRegion.sourceEnv}`);
      }
      if (!resolvedRegion.value) {
        log.err(
          `search-index build requires a region (for example europe/germany) or $${OPENMAPX_REGION_ENV}`,
        );
        completeCliCommand(1);
        return;
      }
      try {
        const status = await runCliDataStep(
          { kind: "search-index-build", region: resolvedRegion.value },
          createCliTransport(),
        );
        log.ok(`Search index published for ${resolvedRegion.value}; execution ${status.id}`);
      } catch (err) {
        log.err(`search-index build failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  searchIndex
    .command("status")
    .description("Show the active OSM search-index snapshot")
    .action(async () => {
      try {
        const status = dm.unwrapDataManagerResponse(
          await dm.getSearchIndexStatus({ transport: createCliTransport() }),
        );
        console.log(
          table(
            [
              { key: "field", header: "Field" },
              { key: "value", header: "Value" },
            ],
            [
              { field: "Region", value: status.region },
              { field: "Status", value: status.status },
              { field: "Stale", value: status.stale ? "yes" : "no" },
              { field: "Building", value: status.building ? "yes" : "no" },
              { field: "Epoch", value: status.epoch ?? "—" },
              { field: "Places", value: String(status.placeCount) },
              { field: "Terms", value: String(status.termCount) },
              { field: "Source fingerprint", value: status.sourceFingerprint ?? "—" },
              { field: "Started", value: status.startedAt ?? "—" },
              { field: "Published", value: status.publishedAt ?? "—" },
              { field: "Last error", value: status.lastError ?? "—" },
            ],
          ),
        );
      } catch (err) {
        log.err(`search-index status failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  const notablePlaces = data
    .command("notable-places")
    .description("Build and inspect the Wikidata index of places known beyond their town");

  notablePlaces
    .command("build")
    .description("Fetch the notable places from Wikidata and publish them for search")
    .action(async () => {
      try {
        const status = await runCliDataStep({ kind: "notable-places-build" }, createCliTransport());
        log.ok(`Notable places published; execution ${status.id}`);
      } catch (err) {
        log.err(`notable-places build failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  notablePlaces
    .command("status")
    .description("Show the published notable-places snapshot")
    .action(async () => {
      try {
        const status = dm.unwrapDataManagerResponse(
          await dm.getNotablePlacesStatus({ transport: createCliTransport() }),
        );
        console.log(
          table(
            [
              { key: "field", header: "Field" },
              { key: "value", header: "Value" },
            ],
            [
              { field: "Status", value: status.status },
              { field: "Building", value: status.building ? "yes" : "no" },
              { field: "Places", value: String(status.placeCount) },
              { field: "Names", value: String(status.nameCount) },
              { field: "Min sitelinks", value: String(status.minSitelinks ?? "—") },
              { field: "Source", value: status.source ?? "—" },
              { field: "Epoch", value: status.epoch ?? "—" },
              { field: "Published", value: status.publishedAt ?? "—" },
              { field: "Last error", value: status.lastError ?? "—" },
            ],
          ),
        );
      } catch (err) {
        log.err(`notable-places status failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  const source = data.command("source").description("Manage desired transit source state");

  source
    .command("list")
    .description("List requested and active transit sources")
    .action(async () => {
      try {
        const result = dm.unwrapDataManagerResponse(
          await dm.getTransitSources(
            {
              limit: 500,
            },
            { transport: createCliTransport() },
          ),
        );
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
        completeCliCommand(1);
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
          completeCliCommand(1);
        }
        try {
          const result = dm.unwrapDataManagerResponse(
            await dm.addTransitSource(
              {
                expectedSourceRevision: dm.unwrapDataManagerResponse(
                  await dm.getTransitSources(undefined, { transport: createCliTransport() }),
                ).sourceRevision,
                url,
                name: options.name,
                region: options.region,
                license: {
                  attribution: options.attribution,
                  ...(options.licenseSpdx ? { spdxIdentifier: options.licenseSpdx } : {}),
                  ...(options.licenseUrl ? { url: options.licenseUrl } : {}),
                },
              },
              { transport: createCliTransport() },
            ),
          );
          log.ok(`Source ${result.sourceId} queued: jobId=${result.jobId}`);
        } catch (err) {
          log.err(`source add failed: ${(err as Error).message}`);
          dataManagerHint();
          completeCliCommand(1);
        }
      },
    );

  source
    .command("remove <sourceId>")
    .description("Remove operator source metadata and start a transactional sync")
    .action(async (sourceId: string) => {
      try {
        const result = dm.unwrapDataManagerResponse(
          await dm.removeTransitSource(
            sourceId,
            {
              expectedSourceRevision: dm.unwrapDataManagerResponse(
                await dm.getTransitSources(undefined, { transport: createCliTransport() }),
              ).sourceRevision,
            },
            { transport: createCliTransport() },
          ),
        );
        log.ok(`Source ${result.sourceId} removal queued: jobId=${result.jobId}`);
      } catch (err) {
        log.err(`source remove failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  source
    .command("disable <sourceId>")
    .description("Reversibly disable a source and start a transactional sync")
    .action(async (sourceId: string) => {
      try {
        const expectedSourceRevision = dm.unwrapDataManagerResponse(
          await dm.getTransitSources(undefined, { transport: createCliTransport() }),
        ).sourceRevision;
        const result = dm.unwrapDataManagerResponse(
          await dm.disableTransitSource(
            sourceId,
            { expectedSourceRevision },
            { transport: createCliTransport() },
          ),
        );
        log.ok(`Source ${result.sourceId} disable queued: jobId=${result.jobId}`);
      } catch (err) {
        log.err(`source disable failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  source
    .command("enable <sourceId>")
    .description("Re-enable a retained source and start a transactional sync")
    .action(async (sourceId: string) => {
      try {
        const result = dm.unwrapDataManagerResponse(
          await dm.enableTransitSource(
            sourceId,
            {
              expectedSourceRevision: dm.unwrapDataManagerResponse(
                await dm.getTransitSources(undefined, { transport: createCliTransport() }),
              ).sourceRevision,
            },
            { transport: createCliTransport() },
          ),
        );
        log.ok(`Source ${result.sourceId} enable queued: jobId=${result.jobId}`);
      } catch (err) {
        log.err(`source enable failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  data
    .command("clean <target>")
    .description(
      "Remove local data for one data type alias (e.g. osm, gtfs, fonts, osrm-graph) or all",
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
            const transport = createCliTransport();
            const reloaded = dm.unwrapDataManagerResponse(await dm.reloadDatasets({ transport }));
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
        completeCliCommand(1);
      }
    });

  data
    .command("overture-sync [region]")
    .description("Atomically refresh Overture places and rebuild regional OSM links")
    .action(async (region: string | undefined) => {
      const transport = createCliTransport();
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Refreshing Overture places for "${resolvedRegion}"…`);
        const status = await runCliDataStep(
          { kind: "overture-sync", region: resolvedRegion },
          transport,
        );
        log.ok(`Overture active for ${resolvedRegion}; execution ${status.id}`);
      } catch (err) {
        log.err(`overture-sync failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  data
    .command("overture-pull [region]")
    .description("Pull Overture Maps places parquet for a region from S3")
    .action(async (region: string | undefined) => {
      const transport = createCliTransport();
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Pulling Overture places for "${resolvedRegion}"…`);
        await dm.pullOvertureWithProgress(
          { region: resolvedRegion },
          {
            onProgress: ({ message }) => log.dim(message),
            transport,
          },
        );
        log.ok(`Overture pull complete for "${resolvedRegion}"`);
      } catch (err) {
        log.err(`overture-pull failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  data
    .command("overture-ingest [region]")
    .description("Ingest Overture places parquet into PostGIS for a region")
    .action(async (region: string | undefined) => {
      const transport = createCliTransport();
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Ingesting Overture places for "${resolvedRegion}"…`);
        await dm.ingestOvertureWithProgress(
          { region: resolvedRegion },
          {
            onProgress: ({ message }) => log.dim(message),
            transport,
          },
        );
        log.ok(`Overture ingest complete for "${resolvedRegion}"`);
      } catch (err) {
        log.err(`overture-ingest failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  data
    .command("overture-conflate [region]")
    .description("Resume the durable OSM extraction and Overture link rebuild")
    .option("--restart", "Discard saved phases and restart from OSM extraction")
    .action(async (region: string | undefined, options: { restart?: boolean }) => {
      const transport = createCliTransport();
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Running Overture conflation for "${resolvedRegion}"…`);
        const status = await runCliDataStep(
          { kind: "overture-conflate", region: resolvedRegion, restart: options.restart === true },
          transport,
        );
        log.ok(`Overture conflation complete for ${resolvedRegion}; execution ${status.id}`);
      } catch (err) {
        log.err(`overture-conflate failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  data
    .command("overture-status")
    .description("Show the installed Overture release and durable conflation phase")
    .action(async () => {
      const transport = createCliTransport();
      try {
        const result = dm.unwrapDataManagerResponse(await dm.getOvertureStatus({ transport }));
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        log.err(`overture-status failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
      }
    });

  data
    .command("overture-extract [region]")
    .description("Extract OSM POIs from the local PBF and write them to overture_places.osm_pois")
    .action(async (region: string | undefined) => {
      const transport = createCliTransport();
      const resolvedRegion = region || process.env.OPENMAPX_REGION || "europe/germany/berlin";
      try {
        log.dim(`Extracting OSM POIs for "${resolvedRegion}"…`);
        await dm.extractOvertureWithProgress(
          { region: resolvedRegion },
          {
            onProgress: ({ message }) => log.dim(message),
            transport,
          },
        );
        log.ok(`OSM POI extraction complete for "${resolvedRegion}"`);
      } catch (err) {
        log.err(`overture-extract failed: ${(err as Error).message}`);
        dataManagerHint();
        completeCliCommand(1);
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
        completeCliCommand(1);
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

      const transport = createCliTransport();
      try {
        const { datasets } = dm.unwrapDataManagerResponse(await dm.getDatasets({ transport }));
        printDataManagerStatusTable(datasets);
      } catch (err) {
        log.warn(
          `status API unavailable (${(err as Error).message}); falling back to filesystem scan`,
        );
        printOfflineStatus();
      }
    });
}
