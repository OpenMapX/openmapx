import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDataCommands } from "../src/commands/data";

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerDataCommands(program);
  return program;
}
afterEach(() => vi.restoreAllMocks());

describe("data notable-places CLI", () => {
  it("builds the index and forwards validated progress messages", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url) => {
      expect(String(url)).toMatch(/\/notable-places\/build$/);
      return new Response(
        [
          { event: "progress", stage: "names", message: "Fetching labels in en" },
          {
            event: "done",
            ok: true,
            epoch: "e1",
            source: "https://qlever.dev/api/wikidata",
            minSitelinks: 8,
            placeCount: 150_000,
            nameCount: 790_000,
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
        {
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          },
        },
      );
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await makeProgram().parseAsync(["data", "notable-places", "build"], { from: "user" });
    const printed = output.mock.calls.flat().join(" ");
    expect(printed).toContain("Fetching labels in en");
    expect(printed).toContain("150000 places");
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
