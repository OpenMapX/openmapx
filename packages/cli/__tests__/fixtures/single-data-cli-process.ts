/** Actual existing data-command assembly; only unrelated command families are
 * omitted to keep this separate-process acceptance fixture focused. */
import { Command } from "commander";
import { registerDataCommands } from "../../src/commands/data";
import {
  assertCliExecutionAvailable,
  withCliExecutionDeadline,
} from "../../src/lib/execution-deadline";

const program = new Command();
registerDataCommands(program);
await withCliExecutionDeadline(process.argv.slice(2), async () => {
  program.hook("preAction", () => assertCliExecutionAvailable());
  await program.parseAsync(process.argv);
});
