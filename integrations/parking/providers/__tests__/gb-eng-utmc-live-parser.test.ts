import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGbEngUtmcLive } from "../gb-eng-utmc-live-parser.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "utmc-dynamic-sample.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe("parseGbEngUtmcLive", () => {
  it("returns a Map keyed by systemCodeNumber", async () => {
    const out = await parseGbEngUtmcLive(FIXTURE, { log: noopLog });
    expect(out.size).toBe(2);
    expect(out.has("CP1")).toBe(true);
    expect(out.has("CP2")).toBe(true);
  });

  it("carries occupancy + stateDescription + asOf from the upstream feed", async () => {
    const out = await parseGbEngUtmcLive(FIXTURE, { log: noopLog });
    expect(out.get("CP1")).toEqual({
      asOf: "2012-01-13T12:19:32.419+0000",
      occupancy: 142,
      stateDescription: "SPACES",
    });
    expect(out.get("CP2")).toEqual({
      asOf: "2012-01-14T10:00:00.000+0000",
      occupancy: 80,
      stateDescription: "FULL",
    });
  });

  it("skips records whose dynamics[] is empty", async () => {
    const out = await parseGbEngUtmcLive(FIXTURE, { log: noopLog });
    expect(out.has("CP-EMPTY")).toBe(false);
  });

  it("falls back to now() when upstream omits lastUpdated", async () => {
    const buffer = Buffer.from(
      JSON.stringify([
        {
          systemCodeNumber: "CP1",
          dynamics: [{ occupancy: 5, stateDescription: "SPACES" }],
        },
      ]),
    );
    const out = await parseGbEngUtmcLive(buffer, { log: noopLog });
    const state = out.get("CP1");
    expect(state).toBeDefined();
    expect(typeof state?.asOf).toBe("string");
    // ISO 8601-ish.
    expect(state?.asOf).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("returns empty map for non-JSON or non-array input", async () => {
    expect((await parseGbEngUtmcLive(Buffer.from("not json"), { log: noopLog })).size).toBe(0);
    expect(
      (await parseGbEngUtmcLive(Buffer.from(JSON.stringify({ not: "array" })), { log: noopLog }))
        .size,
    ).toBe(0);
  });
});
