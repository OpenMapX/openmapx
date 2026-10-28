/** Actual existing data-command assembly; only unrelated command families are
 * omitted to keep this separate-process acceptance fixture focused. */

import { Command } from "commander";
import { registerDataCommands } from "../../src/commands/data";
import { fixedCliCommandExitCode } from "../../src/lib/control-context";
import {
  assertCliExecutionAvailable,
  withCliExecutionDeadline,
} from "../../src/lib/execution-deadline";

const program = new Command();
registerDataCommands(program);
try {
  await withCliExecutionDeadline(process.argv.slice(2), async () => {
    program.hook("preAction", () => assertCliExecutionAvailable());
    await program.parseAsync(process.argv);
  });
} catch (error) {
  if (!process.env.OPENMAPX_CONTROL_DELEGATION && !process.env.OPENMAPX_PARENT_EXECUTION)
    throw error;
  process.stderr.write("Fixed CLI command failed; inspect the original operation status.\n");
  process.exitCode = fixedCliCommandExitCode(error) ?? 1;
}
