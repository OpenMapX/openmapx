import { readFileSync } from "node:fs";
import { services } from "@openmapx/core";
import type { Command } from "commander";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";

const { DataManagerClient } = services;

const DEFAULT_DM_URL = process.env.DATA_MANAGER_URL ?? "http://localhost:4000";

export function registerDataCommands(program: Command): void {
  const data = program.command("data").description("Manage source data");

  data
    .command("download <kind> [region]")
    .description("Download source data (osm <region> | gtfs | style)")
    .option("--countries <list>", "Comma-separated GTFS country codes (gtfs only)")
    .option("--feeds-file <path>", "Path to feeds JSON file (gtfs only)")
    .action(
      async (
        kind: string,
        region: string | undefined,
        options: { countries?: string; feedsFile?: string },
      ) => {
        const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
        try {
          if (kind === "osm") {
            if (!region) {
              log.err("region required (e.g. 'planet', 'europe/germany')");
              process.exit(1);
            }
            const r = await client.downloadOsm(region);
            log.ok(`Downloaded ${region} (${(r.sizeBytes / 1e9).toFixed(2)} GB) → ${r.path}`);
          } else if (kind === "gtfs") {
            if (!options.feedsFile) {
              log.err("--feeds-file required");
              process.exit(1);
            }
            const feeds = JSON.parse(readFileSync(options.feedsFile, "utf-8")) as Array<{
              id: string;
              country: string;
              url: string;
            }>;
            const countries = options.countries?.split(",").filter(Boolean) ?? [];
            const count = await client.downloadGtfs(feeds, countries);
            log.ok(`Downloaded ${count} GTFS feeds`);
          } else if (kind === "style") {
            await client.downloadStyle();
            log.ok("Downloaded styles + fonts + sprites");
          } else {
            log.err(`Unknown kind: ${kind} (use osm | gtfs | style)`);
            process.exit(1);
          }
        } catch (err) {
          log.err(`download failed: ${(err as Error).message}`);
          log.dim(`(is data-manager running? expected at ${DEFAULT_DM_URL})`);
          process.exit(1);
        }
      },
    );

  data
    .command("link")
    .description("Apply the hardlink plan from the most recent compose render")
    .action(async () => {
      const paths = repoPaths();
      const planPath = `${paths.infraDir}/docker-compose.generated.hardlinks.json`;
      let plan: Array<{
        source: string;
        target: string;
        consumerService: string;
        dataType: string;
      }>;
      try {
        plan = JSON.parse(readFileSync(planPath, "utf-8")) as typeof plan;
      } catch (err) {
        log.err(`could not read hardlink plan at ${planPath}: ${(err as Error).message}`);
        log.dim("(run 'openmapx compose render' first)");
        process.exit(1);
        return;
      }

      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        const result = await client.link(plan);
        log.ok(`Linked ${result.linked} files (${result.skipped} already linked)`);
      } catch (err) {
        log.err(`link failed: ${(err as Error).message}`);
        log.dim(`(is data-manager running? expected at ${DEFAULT_DM_URL})`);
        process.exit(1);
      }
    });

  data
    .command("status")
    .description("Show downloaded datasets and sizes")
    .action(async () => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        const datasets = await client.datasets();
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
      } catch (err) {
        log.err(`status failed: ${(err as Error).message}`);
        log.dim(`(is data-manager running? expected at ${DEFAULT_DM_URL})`);
        process.exit(1);
      }
    });
}
