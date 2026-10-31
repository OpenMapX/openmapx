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

describe("data notable-places CLI", () => {
  it("builds the index through the durable command and prints its execution identity", async () => {
    vi.mocked(runCliDataStep).mockResolvedValueOnce(unitDataCommandResult("notable-places-build"));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await makeProgram().parseAsync(["data", "notable-places", "build"], { from: "user" });
    const printed = output.mock.calls.flat().join(" ");
    expect(vi.mocked(runCliDataStep).mock.calls[0]?.[0]).toEqual({ kind: "notable-places-build" });
    expect(printed).toContain(
      "Notable places published; execution 00000000-0000-4000-8000-000000000001",
    );
  });
  it("prints the published snapshot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        ok: true,
        status: "ready",
        building: false,
        placeCount: 150_000,
        nameCount: 790_000,
        minSitelinks: 8,
        source: "https://qlever.dev/api/wikidata",
        epoch: "e1",
        startedAt: null,
        publishedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        lastError: null,
      }),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await makeProgram().parseAsync(["data", "notable-places", "status"], { from: "user" });
    const printed = output.mock.calls.flat().join(" ");
    expect(printed).toContain("ready");
    expect(printed).toContain("https://qlever.dev/api/wikidata");
  });
});
