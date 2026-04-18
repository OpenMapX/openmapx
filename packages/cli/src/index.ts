#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { Command } from "commander";
import { registerCheckCommand } from "./commands/check";
import { registerComposeCommands } from "./commands/compose";
import { registerDataCommands } from "./commands/data";
import { registerReposCommands } from "./commands/repos";
import { registerServicesCommands } from "./commands/services";

const program = new Command();

program
  .name("openmapx")
  .description("OpenMapX self-hosting CLI — manages services, compose, data, and repos")
  .version("1.0.0");

registerServicesCommands(program);
registerComposeCommands(program);
registerDataCommands(program);
registerReposCommands(program);
registerCheckCommand(program);

await program.parseAsync(process.argv);
