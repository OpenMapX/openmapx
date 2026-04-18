import type { Command } from "commander";
import { log } from "../lib/output";

export function registerDataCommands(program: Command): void {
  const data = program.command("data").description("Manage source data");

  data
    .command("download <kind>")
    .description("Download source data (osm | gtfs | tiles)")
    .action(async (kind: string) => {
      log.warn(`'data download ${kind}' is not implemented yet — see Plan 2 (data-manager).`);
      process.exit(2);
    });

  data
    .command("link")
    .description("Hardlink source data into per-service dirs")
    .action(async () => {
      log.warn("'data link' is not implemented yet — see Plan 2 (data-manager).");
      process.exit(2);
    });

  data
    .command("status")
    .description("Show downloaded datasets and sizes")
    .action(async () => {
      log.warn("'data status' is not implemented yet — see Plan 2 (data-manager).");
      process.exit(2);
    });
}
