import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run as filterRun } from "../../src/jobs/transitous/filter.js";
import {
  DEFAULT_TRANSITOUS_API_KEYS_PATH,
  resolveTransitousApiKeysPath,
} from "../../src/jobs/transitous/internal.js";
import { OperatorFeedRelayStore } from "../../src/jobs/transitous/operator-feed-relay.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import type { TransitousScriptRunner } from "../../src/jobs/transitous/script-runner.js";
import { StateStore } from "../../src/state.js";

type FeedSource = { name?: string; skip?: boolean; "api-key"?: string };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

let tmp: string | undefined;

afterEach(() => {
  vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync);
  vi.mocked(readFileSync).mockImplementation(actualFs.readFileSync);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function makeCatalog(dataDir: string): string {
  const catalogDir = join(dataDir, ".transitous-catalog");
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  return catalogDir;
}

function readSources(feedPath: string): FeedSource[] {
  return (JSON.parse(readFileSync(feedPath, "utf-8")) as { sources: FeedSource[] }).sources;
}

/**
 * Script runner that plays out a scripted behaviour per
 * `generate-motis-config.py` dispatch.
 */
function makeRunner(behaviours: Array<"ok" | string>): {
  runScript: TransitousScriptRunner;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const runScript: TransitousScriptRunner = async () => {
    const behaviour = behaviours[Math.min(state.calls, behaviours.length - 1)] ?? "ok";
    state.calls += 1;
    if (behaviour !== "ok") throw Object.assign(new Error(behaviour), { stderr: behaviour });
  };
  return { runScript, state };
}

describe("feeds-overlay catalog write security", () => {
  function fixture(existing = true) {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-private-write-"));
    const catalogDir = makeCatalog(tmp);
    const feedPath = join(catalogDir, "feeds", "de.json");
    if (existing) {
      writeFileSync(
        feedPath,
        JSON.stringify({
          name: "Germany",
          sources: [
            {
              name: "BVG",
              "api-key": "PLAN119_SYNTHETIC_KEY",
              url: "https://operator.example/gtfs?token=PLAN119_SYNTHETIC_URL",
            },
          ],
        }),
      );
      chmodSync(feedPath, 0o644);
    }
    const overlayPath = join(tmp, "feeds-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({
        version: 3,
        sources: existing
          ? []
          : [
              {
                spec: "gtfs",
                type: "http",
                region: "de",
                name: "operator-feed",
                url: "https://operator.example/gtfs",
                origin: "operator",
                license: { spdxIdentifier: "CC-BY-4.0", attribution: "Fixture operator" },
              },
            ],
        patches: existing ? [{ sourceId: "catalog:de:BVG", skip: false }] : [],
        quarantine: [],
      }),
    );
    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      apiKeysPath: join(tmp, "absent-api-keys.json"),
      feedsOverlayPath: overlayPath,
      runner: async () => {},
      runScript: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    ctx.state.catalogDir = catalogDir;
    return { ctx, feedPath };
  }

  it.each([false, true])(
    "is private before preserving credential bytes, including partial failure=%s",
    async (fail) => {
      const { ctx, feedPath } = fixture();
      const before = statSync(feedPath);
      const modes: number[] = [];
      let descriptor: number | undefined;
      vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
        if (typeof data === "string" && data.includes("PLAN119_SYNTHETIC_KEY")) {
          modes.push((typeof file === "number" ? fstatSync(file) : statSync(file)).mode & 0o777);
          if (typeof file === "number") descriptor = file;
          if (fail) {
            actualFs.writeFileSync(
              file,
              data.slice(0, data.indexOf("PLAN119_SYNTHETIC_KEY") + 21),
              options,
            );
            throw new Error("injected catalog write failure");
          }
        }
        actualFs.writeFileSync(file, data, options);
      });
      const result = await filterRun(ctx);
      expect(result.status).toBe(fail ? "error" : "ok");
      if (fail) expect(result.message).toBe("injected catalog write failure");
      else
        expect(JSON.parse(readFileSync(feedPath, "utf-8"))).toEqual({
          name: "Germany",
          sources: [
            {
              name: "BVG",
              "api-key": "PLAN119_SYNTHETIC_KEY",
              url: "https://operator.example/gtfs?token=PLAN119_SYNTHETIC_URL",
              skip: false,
            },
          ],
        });
      expect(modes).toEqual([0o600]);
      expect(readFileSync(feedPath, "utf-8")).toContain("PLAN119_SYNTHETIC_KEY");
      const after = statSync(feedPath);
      expect([after.uid, after.gid, after.ino, after.mode & 0o777]).toEqual([
        before.uid,
        before.gid,
        before.ino,
        0o600,
      ]);
      expect(descriptor).toBeTypeOf("number");
      expect(() => fstatSync(descriptor as number)).toThrow();
    },
  );

  it.each(["symlink", "hardlink"])(
    "rejects a final-path %s without changing external bytes",
    async (kind) => {
      const { ctx, feedPath } = fixture();
      const external = join(ctx.catalogDir, "external.json");
      const original = readFileSync(feedPath, "utf-8");
      writeFileSync(external, original, { mode: 0o644 });
      rmSync(feedPath);
      if (kind === "symlink") symlinkSync(external, feedPath);
      else linkSync(external, feedPath);

      expect((await filterRun(ctx)).status).toBe("error");
      expect(readFileSync(external, "utf-8")).toBe(original);
      expect(statSync(external).mode & 0o777).toBe(0o644);
    },
  );

  it("rejects a final path replaced by a directory before writing", async () => {
    const { ctx, feedPath } = fixture();
    vi.mocked(readFileSync).mockImplementation((file, options) => {
      const data = actualFs.readFileSync(file, options);
      if (file === feedPath) {
        rmSync(feedPath);
        mkdirSync(feedPath);
      }
      return data;
    });
    expect((await filterRun(ctx)).status).toBe("error");
    expect(statSync(feedPath).isDirectory()).toBe(true);
  });

  it("creates new operator catalog files privately without a synthetic region field", async () => {
    const { ctx, feedPath } = fixture(false);
    const modes: number[] = [];
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (typeof data === "string" && data.includes("operator-feed")) {
        if (typeof file !== "number" && !existsSync(feedPath)) {
          actualFs.writeFileSync(file, data, options);
          modes.push(statSync(feedPath).mode & 0o777);
          return;
        }
        modes.push((typeof file === "number" ? fstatSync(file) : statSync(feedPath)).mode & 0o777);
      }
      actualFs.writeFileSync(file, data, options);
    });
    expect((await filterRun(ctx)).status).toBe("ok");
    expect(modes).toEqual([0o600]);
    expect(statSync(feedPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(feedPath, "utf-8"))).not.toHaveProperty("region");
    await ctx.operatorFeedRelay.endRun(ctx.jobId);
  });
});

describe("filter stage", () => {
  it("tightens API-key-stamped feed files to owner-only permissions", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-api-key-mode-"));
    const catalogDir = makeCatalog(tmp);
    const feedPath = join(catalogDir, "feeds", "de.json");
    writeFileSync(
      feedPath,
      JSON.stringify({
        sources: [{ name: "BVG", "transitland-atlas-id": "f-bvg" }],
      }),
    );
    const apiKeysPath = join(tmp, "api-keys.json");
    writeFileSync(apiKeysPath, JSON.stringify({ "de/BVG": "test-key" }));

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      apiKeysPath,
      runner: async () => {},
      runScript: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(readSources(feedPath)[0]?.["api-key"]).toBe("test-key");
    expect(statSync(feedPath).mode & 0o777).toBe(0o600);
  });

  it("reads the keys anew at every run, so a key file replaced by rename applies at the next", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-api-key-replace-"));
    const catalogDir = makeCatalog(tmp);
    const feedPath = join(catalogDir, "feeds", "de.json");
    writeFileSync(
      feedPath,
      JSON.stringify({ sources: [{ name: "BVG", "transitland-atlas-id": "f-bvg" }] }),
    );
    // As mounted: the keys file alone in its own directory.
    const keysDirectory = join(tmp, "config", "transitous");
    mkdirSync(keysDirectory, { recursive: true });
    const apiKeysPath = join(keysDirectory, "api-keys.json");
    writeFileSync(apiKeysPath, JSON.stringify({ "de/BVG": "first-key" }));
    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      apiKeysPath,
      runner: async () => {},
      runScript: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;
    await filterRun(ctx);
    expect(readSources(feedPath)[0]?.["api-key"]).toBe("first-key");

    // generate-api-keys' replacement: a temporary beside it, renamed over it.
    const before = statSync(apiKeysPath).ino;
    const temporary = join(keysDirectory, "api-keys.json.tmp-1");
    writeFileSync(temporary, JSON.stringify({ "de/BVG": "second-key" }), { mode: 0o600 });
    renameSync(temporary, apiKeysPath);
    expect(statSync(apiKeysPath).ino).not.toBe(before);

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(readSources(feedPath)[0]?.["api-key"]).toBe("second-key");
  });

  it("repairs a pre-existing world-readable feed after applying an API key", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-api-key-repair-"));
    const catalogDir = makeCatalog(tmp);
    const feedPath = join(catalogDir, "feeds", "de.json");
    writeFileSync(
      feedPath,
      JSON.stringify({
        sources: [{ name: "BVG", "transitland-atlas-id": "f-bvg" }],
      }),
      { mode: 0o644 },
    );
    const apiKeysPath = join(tmp, "api-keys.json");
    writeFileSync(apiKeysPath, JSON.stringify({ "de/BVG": "test-key" }));

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      apiKeysPath,
      runner: async () => {},
      runScript: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(statSync(feedPath).mode & 0o777).toBe(0o600);
  });

  it("narrows feeds to the requested countries and counts active schedule sources", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-narrow-"));
    const catalogDir = makeCatalog(tmp);
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }, { name: "VBB", skip: true }] }, null, 2),
    );
    writeFileSync(
      join(catalogDir, "feeds", "us.json"),
      JSON.stringify({ sources: [{ name: "MBTA" }] }, null, 2),
    );

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      runner: async () => {},
      runScript: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({
      activeFeeds: 1,
      requestedCount: 2,
      selectedCount: 1,
      skippedCount: 1,
    });
    expect(ctx.state.selectedFeedFiles?.map((f) => f.id)).toEqual(["de"]);
    expect(ctx.state.expectedFeedIds && Array.from(ctx.state.expectedFeedIds)).toContain("de_bvg");
  });

  it("errors when the catalog has no matching feed files for the requested countries", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-nomatch-"));
    const catalogDir = makeCatalog(tmp);
    writeFileSync(
      join(catalogDir, "feeds", "de.json"),
      JSON.stringify({ sources: [{ name: "BVG" }] }, null, 2),
    );

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["zz"],
      runner: async () => {},
      runScript: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/does not contain any feed files for countries: zz/);
  });

  it("pre-skips sources upstream can't resolve and excludes them from the selection", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-prune-"));
    const catalogDir = makeCatalog(tmp);
    const usFeedPath = join(catalogDir, "feeds", "us.json");
    writeFileSync(
      usFeedPath,
      JSON.stringify({
        sources: [
          { name: "Metra", type: "transitland-atlas", "transitland-atlas-id": "f-metra" },
          { name: "MBTA", type: "transitland-atlas", "transitland-atlas-id": "f-mbta" },
        ],
      }),
    );

    // The resolution pre-check fails once citing Metra, then passes after it's
    // skipped — exactly how the real generate-motis-config.py behaves.
    const { runScript, state } = makeRunner(["Error: Could not resolve f-metra", "ok"]);
    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["us"],
      runner: async () => {},
      runScript,
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts?.prunedUnresolvable).toBe(1);
    expect(state.calls).toBe(2);

    const sources = readSources(usFeedPath);
    expect(sources.find((s) => s.name === "Metra")?.skip).toBe(true);
    expect(sources.find((s) => s.name === "MBTA")?.skip).toBeUndefined();

    const expected = ctx.state.expectedFeedIds && Array.from(ctx.state.expectedFeedIds);
    expect(expected).toContain("us_mbta");
    expect(expected).not.toContain("us_metra");
  });

  it("applies feeds-overlay patches to catalog files on disk", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-overlay-"));
    const catalogDir = makeCatalog(tmp);
    const deFeedPath = join(catalogDir, "feeds", "de.json");
    writeFileSync(
      deFeedPath,
      JSON.stringify(
        {
          sources: [
            { name: "BVG", url: "https://old.example/bvg.zip" },
            { name: "VBB", url: "https://old.example/vbb.zip" },
          ],
        },
        null,
        2,
      ),
    );

    const overlayPath = join(tmp, "feeds-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          version: 3,
          sources: [],
          patches: [
            {
              sourceId: "catalog:de:BVG",
              skip: true,
            },
          ],
          quarantine: [],
        },
        null,
        2,
      ),
    );

    const warnings: string[] = [];
    const infos: string[] = [];
    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      feedsOverlayPath: overlayPath,
      runner: async () => {},
      runScript: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
      logger: {
        info: (msg) => infos.push(msg),
        warn: (msg) => warnings.push(msg),
        error: () => {},
      },
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts?.overlayPatchCount).toBe(1);

    const updated = JSON.parse(readFileSync(deFeedPath, "utf-8")) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(updated.sources[0]).toMatchObject({
      url: "https://old.example/bvg.zip",
      skip: true,
    });
    expect(statSync(deFeedPath).mode & 0o777).toBe(0o600);
    expect(infos.some((m) => m.includes("applying 1 feeds-overlay patch"))).toBe(true);
  });

  it("applies the data directory's overlay when no path is configured, as scheduled runs do", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-default-overlay-"));
    const catalogDir = makeCatalog(tmp);
    const deFeedPath = join(catalogDir, "feeds", "de.json");
    writeFileSync(
      deFeedPath,
      JSON.stringify({
        sources: [
          { name: "BVG", url: "https://old.example/bvg.zip" },
          { name: "VBB", url: "https://old.example/vbb.zip" },
        ],
      }),
    );
    mkdirSync(join(tmp, "overrides"));
    writeFileSync(
      join(tmp, "overrides", "feeds-overlay.json"),
      JSON.stringify({
        version: 3,
        sources: [],
        patches: [{ sourceId: "catalog:de:BVG", skip: true }],
        quarantine: [],
      }),
    );
    // Compose renders an unset variable as an empty string.
    vi.stubEnv("TRANSITOUS_FEEDS_OVERLAY_PATH", "");
    try {
      const ctx = buildJobContext({
        dataDir: tmp,
        store: new StateStore(tmp),
        countries: ["de"],
        apiKeysPath: join(tmp, "absent-api-keys.json"),
        runner: async () => {},
        runScript: async () => {},
        now: () => "2026-05-01T00:00:00.000Z",
      });
      ctx.state.catalogDir = catalogDir;

      const result = await filterRun(ctx);
      expect(result.status).toBe("ok");
      expect(result.artifacts?.overlayPatchCount).toBe(1);
      expect(readSources(deFeedPath)[0]).toMatchObject({ skip: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to the mounted API keys when the env var renders empty", () => {
    vi.stubEnv("TRANSITOUS_API_KEYS_PATH", "");
    try {
      expect(resolveTransitousApiKeysPath()).toBe(DEFAULT_TRANSITOUS_API_KEYS_PATH);
      expect(resolveTransitousApiKeysPath("")).toBe(DEFAULT_TRANSITOUS_API_KEYS_PATH);
      expect(resolveTransitousApiKeysPath("/explicit.json")).toBe("/explicit.json");
      vi.stubEnv("TRANSITOUS_API_KEYS_PATH", "/configured.json");
      expect(resolveTransitousApiKeysPath()).toBe("/configured.json");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("writes only run-bound relay URLs for operator sources into the upstream catalog", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-filter-operator-relay-"));
    const catalogDir = makeCatalog(tmp);
    const deFeedPath = join(catalogDir, "feeds", "de.json");
    writeFileSync(deFeedPath, JSON.stringify({ sources: [{ name: "BVG" }] }));
    const overlayPath = join(tmp, "feeds-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({
        version: 3,
        sources: [
          {
            spec: "gtfs",
            type: "http",
            region: "de",
            name: "operator-feed",
            url: "https://operator.example/private/feed.zip?fixture=secret",
            origin: "operator",
            license: { spdxIdentifier: "CC-BY-4.0", attribution: "Operator" },
          },
        ],
        patches: [],
        quarantine: [],
      }),
    );
    const relay = new OperatorFeedRelayStore();
    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      countries: ["de"],
      feedsOverlayPath: overlayPath,
      runner: async () => {},
      runScript: async () => {},
      jobId: "run-filter",
      operatorFeedRelay: relay,
    });
    ctx.state.catalogDir = catalogDir;

    const result = await filterRun(ctx);

    expect(result.status).toBe("ok");
    const catalogText = readFileSync(deFeedPath, "utf-8");
    expect(catalogText).toContain("http://127.0.0.1:4000/internal/transit/operator-feed/");
    expect(catalogText).not.toContain("operator.example");
    expect(catalogText).not.toContain("fixture=secret");
    await relay.endRun("run-filter");
  });
});
