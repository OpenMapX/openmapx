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

describe("data search-index CLI", () => {
  it("exposes nested build and status commands", () => {
    const data = makeProgram().commands.find((command) => command.name() === "data");
    const searchIndex = data?.commands.find((command) => command.name() === "search-index");
    expect(searchIndex?.commands.map((command) => command.name())).toEqual(["build", "status"]);
  });
  it("builds the selected region and forwards validated progress messages", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (url, options) => {
      expect(String(url)).toMatch(/\/search-index\/build$/);
      expect(JSON.parse(options?.body as string)).toEqual({ region: "europe/germany" });
      return new Response(
        [
          { event: "progress", stage: "extract", message: "Extracted 42 places" },
          {
            event: "done",
            ok: true,
            region: "europe/germany",
            epoch: "epoch-2",
            sourceFingerprint: "fingerprint",
            placeCount: 42,
            termCount: 84,
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
    await makeProgram().parseAsync(["data", "search-index", "build", "europe/germany"], {
      from: "user",
    });
    expect(output.mock.calls.flat().join(" ")).toContain("Extracted 42 places");
    expect(output.mock.calls.flat().join(" ")).toContain("42 places");
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
