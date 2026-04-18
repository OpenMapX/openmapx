import type { Command } from "commander";
import { dockerComposeStream } from "../lib/docker";
import { log } from "../lib/output";

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Run health checks against running services")
    .action(async () => {
      log.info("Listing running containers (full health-check polling lands in a later plan):");
      const code = await dockerComposeStream(["ps", "--format", "table"]);
      process.exit(code);
    });
}
