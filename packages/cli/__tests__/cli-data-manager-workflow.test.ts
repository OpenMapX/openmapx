import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDataCommands } from "../src/commands/data";

function program() {
  const command = new Command();
  command.exitOverride();
  registerDataCommands(command);
  return command;
}
afterEach(() => vi.restoreAllMocks());

describe("data-manager CLI result policy", () => {
  it("exits unsuccessfully for a valid unsuccessful conflation completion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          event: "done",
          ok: false,
          status: "waiting_for_osm",
          linked: 0,
          pbfPath: "/data/osm/region.osm.pbf",
          message: "OSM input unavailable",
        }),
        {
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          },
        },
      ),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    await expect(
      program().parseAsync(["data", "overture-conflate", "europe/germany"], { from: "user" }),
    ).rejects.toThrow("exit:1");
    expect(errors.mock.calls.flat().join(" ")).toContain("OSM input unavailable");
    expect(output.mock.calls.flat().join(" ")).not.toContain("conflation complete");
  });
  it("does not announce downloaded fonts for a malformed successful HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({}));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    await expect(
      program().parseAsync(["data", "download", "fonts"], { from: "user" }),
    ).rejects.toThrow("exit:1");
    expect(errors.mock.calls.flat().join(" ")).toContain("response contract failed");
    expect(output.mock.calls.flat().join(" ")).not.toContain("Downloaded map glyphs");
  });
});
