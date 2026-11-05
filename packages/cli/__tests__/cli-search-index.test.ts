import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDataCommands } from "../src/commands/data";
import { runCliDataStep } from "../src/lib/data-execution";
import { unitDataCommandResult } from "./helpers/data-command-result";

// Command presentation/result-policy unit boundary. Durable POST/GET identity,
// signed containment and SQL ownership belong to the real execution suites.
vi.mock("../src/lib/data-execution", () => ({ runCliDataStep: vi.fn() }));

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerDataCommands(program);
  return program;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runCliDataStep).mockReset();
});

describe("data search-index CLI", () => {
  it("exposes nested build and status commands", () => {
    const data = makeProgram().commands.find((command) => command.name() === "data");
    const searchIndex = data?.commands.find((command) => command.name() === "search-index");
    expect(searchIndex?.commands.map((command) => command.name())).toEqual(["build", "status"]);
  });
  it("builds the selected region through the durable command and prints its execution identity", async () => {
    vi.mocked(runCliDataStep).mockResolvedValueOnce(unitDataCommandResult("search-index-build"));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await makeProgram().parseAsync(["data", "search-index", "build", "europe/germany"], {
      from: "user",
    });
    expect(vi.mocked(runCliDataStep).mock.calls[0]?.[0]).toEqual({
      kind: "search-index-build",
      region: "europe/germany",
    });
    expect(output.mock.calls.flat().join(" ")).toContain(
      "Search index published for europe/germany; execution 00000000-0000-4000-8000-000000000001",
    );
  });
  it("prints the operational status fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        ok: true,
        region: "europe/germany",
        status: "ready",
        stale: true,
        building: false,
        epoch: "epoch-1",
        placeCount: 123,
        termCount: 456,
        sourcePath: "/data/osm/region.osm.pbf",
        sourceFingerprint: "sha256:abc",
        currentFingerprint: "sha256:abc",
        startedAt: "2026-08-13T01:00:00.000Z",
        publishedAt: "2026-08-13T01:05:00.000Z",
        updatedAt: "2026-08-13T01:05:00.000Z",
        lastError: null,
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await makeProgram().parseAsync(["data", "search-index", "status"], { from: "user" });
    const text = output.mock.calls.flat().join(" ");
    for (const field of [
      "europe/germany",
      "epoch-1",
      "123",
      "456",
      "sha256:abc",
      "2026-08-13T01:05:00.000Z",
    ])
      expect(text).toContain(field);
  });
});
