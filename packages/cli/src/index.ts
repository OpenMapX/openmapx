#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { Command } from "commander";
import { registerBackupCommands } from "./commands/backup";
import { registerCacheCommands } from "./commands/cache";
import { registerCheckCommand } from "./commands/check";
import { registerComposeCommands } from "./commands/compose";
import { registerDataCommands } from "./commands/data";
import { registerExtCommands } from "./commands/ext";
import { registerIntegrationsCommands } from "./commands/integrations";
import { registerServicesCommands } from "./commands/services";
import { registerTransitousCommands } from "./commands/transitous-bump";
import { registerTransportApisPinCommands } from "./commands/transport-apis-pin";
import { registerUsersCommands } from "./commands/users";
import { fixedCliCommandExitCode } from "./lib/control-context";
import { assertCliExecutionAvailable, withCliExecutionDeadline } from "./lib/execution-deadline";
import { loadInfraEnv } from "./lib/infra-env";

// Mirror Docker Compose's behaviour: auto-load infra/docker/.env so that
// `--domain` and `SERVICE_<ID>_<KEY>` overrides resolve consistently between
// `pnpm openmapx compose render` (CLI) and `docker compose up` (compose).

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
registerExtCommands(program);
registerBackupCommands(program);
registerUsersCommands(program);
registerCheckCommand(program);
registerCacheCommands(program);
registerTransportApisPinCommands(program);
registerTransitousCommands(program);

try {
  await withCliExecutionDeadline(process.argv.slice(2), async () => {
    loadInfraEnv();
    program.hook("preAction", () => assertCliExecutionAvailable());
    await program.parseAsync(process.argv);
  });
} catch (error) {
  if (!process.env.OPENMAPX_CONTROL_DELEGATION && !process.env.OPENMAPX_PARENT_EXECUTION)
    throw error;
  // The control context has already retained its actual disposition and closed
  // local handles. Avoid forwarding exception paths/stacks to public job logs.
  process.stderr.write("Fixed CLI command failed; inspect the original operation status.\n");
  process.exitCode = fixedCliCommandExitCode(error) ?? 1;
}
