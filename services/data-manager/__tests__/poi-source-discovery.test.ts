import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __clearPoiSourceRegistry, getAllPoiSources } from "@openmapx/poi-source-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverPoiSources } from "../src/poi-source-discovery.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

let tmpRoot: string;

beforeEach(() => {
  __clearPoiSourceRegistry();
  tmpRoot = mkdtempSync(join(tmpdir(), "poi-discovery-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeIntegration(name: string, fileContents: string | null, ext: "js" = "js") {
  const intDir = join(tmpRoot, "integrations", name);
  mkdirSync(intDir, { recursive: true });
  if (fileContents !== null) {
    writeFileSync(join(intDir, `poi-sources.${ext}`), fileContents);
  }
}

const VALID_SOURCE_DECL_JS = `
export function declarePoiSources() {
  return [
    {
      id: "fixture-ev-1",
      domain: "ev-charging",
      name: "Fixture EV 1",
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: "https://example.test/data.csv" },
        parse: function* () {},
      },
    },
  ];
}
`;

// Migrated sources declare structured `parts` and NO explicit `id` — the
// registry derives id/stationIdPrefix. Discovery must accept this shape.
const VALID_PARTS_SOURCE_DECL_JS = `
export function declarePoiSources() {
  return [
    {
      parts: { country: "de", operator: "bnetza" },
      domain: "ev-charging",
      name: "Fixture BNetzA",
      static: {
        cron: "0 4 * * *",
        fetch: { type: "http", url: "https://example.test/data.csv" },
        parse: function* () {},
      },
    },
  ];
}
`;

const BROKEN_DECL_JS = `
export function declarePoiSources() {
  throw new Error("parser is broken");
}
`;

const WRONG_SHAPE_JS = `
export function declarePoiSources() {
  return "not an array";
}
`;

const NO_EXPORT_JS = `
export const somethingElse = 42;
`;

describe("discoverPoiSources", () => {
  it("registers sources from a valid integration", async () => {
    writeIntegration("ev-charging", VALID_SOURCE_DECL_JS);
    const logger = makeLogger();

    const result = await discoverPoiSources({ rootDir: tmpRoot, logger });

    expect(result.scanned).toBe(1);
    expect(result.withSources).toBe(1);
    expect(result.registered).toBe(1);
    expect(result.errors).toEqual([]);
    expect(getAllPoiSources().map((s) => s.id)).toEqual(["fixture-ev-1"]);
    expect(logger.info).toHaveBeenCalledWith(
      "poi-source-discovery: scan complete",
      expect.objectContaining({ scanned: 1, withSources: 1, registered: 1 }),
    );
  });

  it("registers a parts-based source (no explicit id) under its derived id", async () => {
    writeIntegration("ev-charging", VALID_PARTS_SOURCE_DECL_JS);
    const logger = makeLogger();

    const result = await discoverPoiSources({ rootDir: tmpRoot, logger });

    expect(result.registered).toBe(1);
    expect(result.errors).toEqual([]);
    expect(getAllPoiSources().map((s) => s.id)).toEqual(["de-bnetza"]);
    expect(getAllPoiSources()[0].stationIdPrefix).toBe("de-bnetza:");
  });

  it("throws when a builtin integration's poi-sources module fails to load", async () => {
    writeIntegration("ev-charging", VALID_SOURCE_DECL_JS);
    writeIntegration("broken-integration", BROKEN_DECL_JS);
    const logger = makeLogger();

    await expect(discoverPoiSources({ rootDir: tmpRoot, logger })).rejects.toThrow(
      /builtin POI-source discovery failed for: broken-integration/,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "poi-source-discovery: failed to load integration poi-sources",
      expect.objectContaining({ integration: "broken-integration" }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "poi-source-discovery: builtin POI-source discovery failed",
      expect.objectContaining({ integrations: ["broken-integration"] }),
    );
  });

  it("skips integrations without a poi-sources file (silent)", async () => {
    writeIntegration("no-poi", null);
    writeIntegration("with-poi", VALID_SOURCE_DECL_JS);
    const logger = makeLogger();

    const result = await discoverPoiSources({ rootDir: tmpRoot, logger });

    expect(result.scanned).toBe(2);
    expect(result.withSources).toBe(1);
    expect(result.registered).toBe(1);
    expect(result.errors).toEqual([]);
    // No warn about the missing file — silent skip
    const missingFileWarns = logger.warn.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("no-poi"),
    );
    expect(missingFileWarns).toHaveLength(0);
  });

  it("warns when poi-sources has no declarePoiSources export", async () => {
    writeIntegration("no-export", NO_EXPORT_JS);
    const logger = makeLogger();

    const result = await discoverPoiSources({ rootDir: tmpRoot, logger });

    expect(result.withSources).toBe(0);
    expect(result.registered).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("has no declarePoiSources()"),
      expect.objectContaining({ integration: "no-export" }),
    );
  });

  it("warns when declarePoiSources returns the wrong shape", async () => {
    writeIntegration("wrong-shape", WRONG_SHAPE_JS);
    const logger = makeLogger();

    const result = await discoverPoiSources({ rootDir: tmpRoot, logger });

    expect(result.withSources).toBe(0);
    expect(result.registered).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not return PoiSource[]"),
      expect.objectContaining({ integration: "wrong-shape" }),
    );
  });

  it("never imports POI declarations from the untrusted community directory", async () => {
    writeIntegration("builtin-1", VALID_SOURCE_DECL_JS);
    const customRoot = join(tmpRoot, "custom_integrations");
    try {
      const communityDir = join(customRoot, "community-source");
      mkdirSync(communityDir, { recursive: true });
      writeFileSync(
        join(communityDir, "poi-sources.js"),
        `globalThis.__untrustedPoiExecuted = true;\n${VALID_SOURCE_DECL_JS.replace("fixture-ev-1", "community-ev-1")}`,
      );
      const logger = makeLogger();
      const g = globalThis as Record<string, unknown>;

      const result = await discoverPoiSources({ rootDir: tmpRoot, logger });

      expect(result.scanned).toBe(1);
      expect(result.registered).toBe(1);
      expect(getAllPoiSources().map((s) => s.id)).toEqual(["fixture-ev-1"]);
      expect(g.__untrustedPoiExecuted).toBeUndefined();
    } finally {
      delete (globalThis as Record<string, unknown>).__untrustedPoiExecuted;
      rmSync(customRoot, { recursive: true, force: true });
    }
  });

  it("returns empty result when rootDir does not exist", async () => {
    const logger = makeLogger();
    const result = await discoverPoiSources({
      rootDir: "/nonexistent/path",
      logger,
    });
    expect(result).toEqual({ scanned: 0, withSources: 0, registered: 0, errors: [] });
  });

  it("throws when a builtin source declaration is invalid (registry throws)", async () => {
    const INVALID_ID = `
export function declarePoiSources() {
  return [{
    id: "BAD_UPPERCASE",
    domain: "ev-charging",
    name: "Bad",
    static: {
      cron: "0 4 * * *",
      fetch: { type: "http", url: "https://example.test" },
      parse: function* () {},
    },
  }];
}
`;
    writeIntegration("bad-source", INVALID_ID);
    const logger = makeLogger();

    await expect(discoverPoiSources({ rootDir: tmpRoot, logger })).rejects.toThrow(
      /builtin POI-source discovery failed for: bad-source/,
    );
    expect(getAllPoiSources()).toEqual([]);
  });
});
