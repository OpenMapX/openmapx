import type { Command } from "commander";
import { log } from "../lib/output";

export function registerReposCommands(program: Command): void {
  const repos = program.command("repos").description("Manage service repositories");

  repos
    .command("list")
    .description("List registered service repositories")
    .action(async () => {
      log.warn("'repos list' is not implemented yet — see Plan 4 (community repos).");
      process.exit(2);
    });

  repos
    .command("add <url>")
    .description("Register a service repository from a Git URL")
    .action(async (url: string) => {
      log.warn(`'repos add ${url}' is not implemented yet — see Plan 4 (community repos).`);
      process.exit(2);
    });

  repos
    .command("remove <id>")
    .description("Unregister a service repository")
    .action(async (id: string) => {
      log.warn(`'repos remove ${id}' is not implemented yet — see Plan 4 (community repos).`);
      process.exit(2);
    });
}
