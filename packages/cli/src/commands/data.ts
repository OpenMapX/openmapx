import { readFileSync } from "node:fs";
import { services } from "@openmapx/core/server";
import type { Command } from "commander";
import kleur from "kleur";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";

const { DataManagerClient } = services;

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
      // Non-TTY: only print when the text changes materially so logs don't
      // explode. (Here: every second of progress, same string suffices.)
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
            const started = Date.now();
            const render = progressRenderer();
            const r = await client.downloadOsm(region, {
              onProgress: (bytes, total) => render.update(bytes, total, started),
            });
            render.done();
            log.ok(`Downloaded ${region} (${(r.sizeBytes / 1e9).toFixed(2)} GB) → ${r.path}`);
          } else if (kind === "gtfs") {
            const countries = options.countries?.split(",").filter(Boolean) ?? [];
            let result: { count: number; resolvedFromCatalog: boolean };
            if (options.feedsFile) {
              const feeds = JSON.parse(readFileSync(options.feedsFile, "utf-8")) as Array<{
                id: string;
                country: string;
                url: string;
              }>;
              result = await client.downloadGtfs({ feeds, countries });
            } else {
              log.dim(
                "no --feeds-file; resolving feeds from Transitous catalog (pass --feeds-file to override)",
              );
              result = await client.downloadGtfs({ source: "transitous", countries });
            }
            const src = result.resolvedFromCatalog ? " (from Transitous catalog)" : "";
            log.ok(`Downloaded ${result.count} GTFS feeds${src}`);
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
    .command("convert <kind> [region]")
    .description(
      "Derive a secondary format from an existing download (kind: overpass — converts OSM PBF → OSM BZ2 for Overpass)",
    )
    .action(async (kind: string, region: string | undefined) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        if (kind === "overpass") {
          const started = Date.now();
          const render = progressRenderer();
          const r = await client.convertOverpass({
            region,
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
        log.dim(`(is data-manager running? expected at ${DEFAULT_DM_URL})`);
        process.exit(1);
      }
    });

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
