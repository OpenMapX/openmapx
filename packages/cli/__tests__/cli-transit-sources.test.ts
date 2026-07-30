import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerDataCommands } from "../src/commands/data";

describe("transit source CLI", () => {
  it("exposes lifecycle commands without direct feed import/remove commands", () => {
    const program = new Command();
    registerDataCommands(program);

    const data = program.commands.find((command) => command.name() === "data");
    expect(data).toBeDefined();
    const commandNames = data?.commands.map((command) => command.name()) ?? [];
    expect(commandNames).toContain("sync");
    expect(commandNames).toContain("source");
    expect(commandNames).not.toContain("add-feed");
    expect(commandNames).not.toContain("remove-feed");

    const download = data?.commands.find((command) => command.name() === "download");
    expect(download?.options.map((option) => option.long)).not.toContain("--feeds-file");

    const source = data?.commands.find((command) => command.name() === "source");
    expect(source?.commands.map((command) => command.name())).toEqual([
      "list",
      "add",
      "remove",
      "enable",
    ]);
  });
});
