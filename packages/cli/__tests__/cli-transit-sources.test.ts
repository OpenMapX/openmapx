import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDataCommands } from "../src/commands/data";

afterEach(() => vi.restoreAllMocks());
it.each(["enable", "remove", "disable"])(
  "reads and sends the exact desired revision when the user requests source %s",
  async (action) => {
    const revision = "a".repeat(64),
      requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input),
        method = init?.method ?? "GET";
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(
        method === "GET"
          ? { sourceRevision: revision, sources: [], total: 0, limit: 50, offset: 0 }
          : { jobId: "fixture-job", sourceId: "operator:de:demo", status: "started" },
        { status: method === "GET" ? 200 : 202 },
      );
    });
    const program = new Command();
    program.exitOverride();
    registerDataCommands(program);
    await program.parseAsync(["data", "source", action, "operator:de:demo"], { from: "user" });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).not.toContain("transport=");
    expect(requests[1].body).toEqual({ expectedSourceRevision: revision });
    expect(requests[1].method).toBe(action === "remove" ? "DELETE" : "POST");
    if (action !== "remove") expect(requests[1].url).toContain(`/${action}`);
  },
);

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
      "disable",
      "enable",
    ]);
  });
});
