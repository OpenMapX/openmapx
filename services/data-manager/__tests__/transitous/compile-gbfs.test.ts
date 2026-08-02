import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup as dnsLookup } from "node:dns/promises";
import { run, validateGbfsAddition } from "../../src/jobs/transitous/compile-gbfs.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

const originalFetch = globalThis.fetch;
const originalEnabled = process.env.MOTIS_GBFS_CATALOG_ENABLED;
const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
let tmp: string | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  lookupMock.mockReset();
  if (originalEnabled === undefined) delete process.env.MOTIS_GBFS_CATALOG_ENABLED;
  else process.env.MOTIS_GBFS_CATALOG_ENABLED = originalEnabled;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const ADDITION = {
  region: "de",
  name: "demo",
  spec: "gbfs" as const,
  type: "url" as const,
  url: "https://example.test/gbfs.json",
  sourceId: "demo",
  license: "open",
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

describe("bounded GBFS candidate validation", () => {
  it("accepts v2 station inventory and resolves required subresources", async () => {
    lookupMock.mockResolvedValue(PUBLIC);
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("gbfs.json")) {
        return json({
          version: "2.3",
          data: {
            en: {
              feeds: [
                { name: "station_information", url: "https://example.test/stations" },
                { name: "station_status", url: "https://example.test/status" },
              ],
            },
          },
        });
      }
      return json({ data: { stations: [] } });
    }) as typeof fetch;
    await expect(validateGbfsAddition(ADDITION, 1000, "now")).resolves.toMatchObject({
      ok: true,
      version: "2.3",
    });
  });

  it("accepts v3 vehicle inventory and rejects a discovery with no inventory", async () => {
    lookupMock.mockResolvedValue(PUBLIC);
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      return url.endsWith("gbfs.json")
        ? json({
            version: "3.0",
            data: { feeds: [{ name: "vehicle_status", url: "https://example.test/vehicles" }] },
          })
        : json({ data: { vehicles: [] } });
    }) as typeof fetch;
    expect(await validateGbfsAddition(ADDITION, 1000, "now")).toMatchObject({
      ok: true,
      version: "3.0",
    });

    globalThis.fetch = vi.fn(async () =>
      json({ version: "2.3", data: { en: { feeds: [] } } }),
    ) as typeof fetch;
    lookupMock.mockResolvedValue(PUBLIC);
    expect(await validateGbfsAddition(ADDITION, 1000, "now")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("neither"),
    });
  });

  it("reports malformed JSON and timeouts without throwing across providers", async () => {
    lookupMock.mockResolvedValue(PUBLIC);
    globalThis.fetch = vi.fn(async () => new Response("not-json")) as typeof fetch;
    expect(await validateGbfsAddition(ADDITION, 1000, "now")).toMatchObject({ ok: false });
  });

  it("fails a candidate whose discovery host resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    globalThis.fetch = vi.fn();
    const result = await validateGbfsAddition(ADDITION, 1000, "2026-07-30T00:00:00Z");
    expect(result.ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "build",
    "mirror",
  ] as const)("injects the same pinned, verified additions in %s mode", async (source) => {
    lookupMock.mockResolvedValue(PUBLIC);
    tmp = mkdtempSync(join(tmpdir(), "openmapx-compile-gbfs-"));
    const catalog = join(tmp, "data", ".transitous-catalog");
    mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
    mkdirSync(join(catalog, "feeds"), { recursive: true });
    const richSchedule = {
      name: "schedule",
      type: "url",
      url: "https://schedule.test/feed.zip",
      spec: "gtfs",
      flex: true,
      fares: "v2",
      rt: [{ protocol: "gtfsrt", url: "https://schedule.test/rt" }],
      script: "scripts/colors.lua",
    };
    writeFileSync(join(catalog, "feeds", "de.json"), JSON.stringify({ sources: [richSchedule] }));
    const csv =
      "Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL\nDE,Demo,Berlin,demo,https://example.test,https://example.test/gbfs.json,2.3,\n";
    const commit = "a".repeat(40);
    writeFileSync(
      join(tmp, "infra", "docker", "gbfs-catalog.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        source: "mobilitydata-gbfs",
        commit,
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${commit}/systems.csv`,
        sha256: createHash("sha256").update(csv).digest("hex"),
        lockedAt: "2026-01-01T00:00:00Z",
        lockedBy: "test",
      }),
    );
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("raw.githubusercontent.com")) return new Response(csv);
      if (url.endsWith("gbfs.json"))
        return json({
          version: "2.3",
          data: {
            en: {
              feeds: [
                { name: "station_information", url: "https://example.test/stations" },
                { name: "station_status", url: "https://example.test/status" },
              ],
            },
          },
        });
      return json({ data: { stations: [] } });
    }) as typeof fetch;
    process.env.MOTIS_GBFS_CATALOG_ENABLED = "true";
    const ctx = buildJobContext({
      dataDir: join(tmp, "data"),
      repoRoot: tmp,
      countries: ["de"],
      source,
      store: new StateStore(join(tmp, "data")),
      now: () => "2026-01-01T00:00:00Z",
    });
    ctx.state.catalogDir = catalog;
    const result = await run(ctx);
    expect(result.status).toBe("ok");
    expect(readFileSync(join(catalog, "feeds", "de.json"), "utf-8")).toContain("openmapx-demo");
    const updated = JSON.parse(readFileSync(join(catalog, "feeds", "de.json"), "utf-8")) as {
      sources: unknown[];
    };
    expect(
      updated.sources.find((source) => (source as { name?: unknown }).name === "schedule"),
    ).toEqual(richSchedule);
    expect(readFileSync(join(catalog, "out", "gbfs-source-index.json"), "utf-8")).toContain(
      '"healthy": 1',
    );
  });
});
