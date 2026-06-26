#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { Command } from "commander";
import { registerBackupCommands } from "./commands/backup";
import { registerCacheCommands } from "./commands/cache";
import { registerCheckCommand } from "./commands/check";
import { registerComposeCommands } from "./commands/compose";
import { registerDataCommands } from "./commands/data";
import { registerExtCommands } from "./commands/ext";
import { registerIntegrationsCommands } from "./commands/integrations";
import { registerPoiIngestCommands } from "./commands/poi-ingest";
import { registerReposCommands } from "./commands/repos";
import { registerServicesCommands } from "./commands/services";
import { registerTransitousCommands } from "./commands/transitous-bump";
import { registerUsersCommands } from "./commands/users";
import { loadInfraEnv } from "./lib/infra-env";

// Mirror Docker Compose's behaviour: auto-load infra/docker/.env so that
// `--domain` and `SERVICE_<ID>_<KEY>` overrides resolve consistently between
// `pnpm openmapx compose render` (CLI) and `docker compose up` (compose).
loadInfraEnv();

const program = new Command();

program
  .name("openmapx")
  .description(
    "OpenMapX self-hosting CLI — manages services, integrations, compose, data, and repos",
  )
  .version("1.0.0");

registerServicesCommands(program);
registerIntegrationsCommands(program);
registerComposeCommands(program);
registerDataCommands(program);
registerPoiIngestCommands(program);
registerReposCommands(program);
registerExtCommands(program);
registerBackupCommands(program);
registerUsersCommands(program);
registerCheckCommand(program);
registerCacheCommands(program);
registerTransitousCommands(program);

await program.parseAsync(process.argv);
