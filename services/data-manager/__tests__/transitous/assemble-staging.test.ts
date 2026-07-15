import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfigInputs, run } from "../../src/jobs/transitous/assemble-staging.js";
import { CANDIDATE_PROXY_DIRNAME } from "../../src/jobs/transitous/candidate.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

// ---------------------------------------------------------------------------
// parseConfigInputs — pure unit tests
// ---------------------------------------------------------------------------

// The real MOTIS config.yml format (as produced by generate-motis-config.py):
//
//   server:
//     port: 8080
//   timetable:
//     datasets:
//       feed-a:
//         path: feed-a.gtfs.zip
//       feed-b:
//         path: feed-b.gtfs.zip
//   osm: germany.osm.pbf
//
// `path:` is indented under a dataset key; `osm:` is at top level.
// The regex is `^\s*path:\s*["']?([^"'\s]+)["']?\s*$` — it matches any
// line where `path:` is preceded only by whitespace (no `- ` prefix).

describe("parseConfigInputs", () => {
  it("extracts two path entries (quoted and unquoted) and an osm entry", () => {
    const config = [
      "server:",
      "  port: 8080",
      "timetable:",
      "  datasets:",
      "    feed-a:",
      "      path: 'feed-a.gtfs.zip'",
      "    feed-b:",
      "      path: feed-b.gtfs.zip",
      "osm: 'germany.osm.pbf'",
    ].join("\n");
    const result = parseConfigInputs(config);
    expect(result.gtfs).toHaveLength(2);
    expect(result.gtfs).toContain("feed-a.gtfs.zip");
    expect(result.gtfs).toContain("feed-b.gtfs.zip");
    expect(result.osm).toBe("germany.osm.pbf");
  });

  it("returns undefined osm when no osm line is present", () => {
    const config = [
      "timetable:",
      "  datasets:",
      "    only-feed:",
      "      path: only-feed.gtfs.zip",
    ].join("\n");
    const result = parseConfigInputs(config);
    expect(result.gtfs).toEqual(["only-feed.gtfs.zip"]);
    expect(result.osm).toBeUndefined();
  });

  it("returns empty gtfs array and no osm for an empty string", () => {
    const result = parseConfigInputs("");
    expect(result.gtfs).toEqual([]);
    expect(result.osm).toBeUndefined();
  });

  it("deduplicates path entries that appear twice", () => {
    const config = [
      "timetable:",
      "  datasets:",
      "    dup-1:",
      "      path: dup.gtfs.zip",
      "    dup-2:",
      "      path: dup.gtfs.zip",
      "    other:",
      "      path: other.gtfs.zip",
    ].join("\n");
    const result = parseConfigInputs(config);
    expect(result.gtfs).toHaveLength(2);
    expect(result.gtfs).toContain("dup.gtfs.zip");
    expect(result.gtfs).toContain("other.gtfs.zip");
  });

  it("matches path: entries with deep indentation (the regex uses \\s* anchor)", () => {
    // The real config indents `path:` 6 spaces deep — assert the regex handles it.
    const config =
      "timetable:\n  datasets:\n    deeply-nested:\n      path: indented-feed.gtfs.zip\n";
    const result = parseConfigInputs(config);
    expect(result.gtfs).toContain("indented-feed.gtfs.zip");
  });
});

// ---------------------------------------------------------------------------
// Fixture helpers for run()
// ---------------------------------------------------------------------------

interface FixtureOptions {
  /** Write config.yml referencing feeds + osm into outDir. */
  withConfig?: boolean;
  /** Feed basenames to create as real files in outDir. */
  feeds?: string[];
  /** OSM extract basename to create in the live dir (carried forward). */
  osmInLive?: string;
  /** OSM extract basename to reference in config but NOT create anywhere. */
  osmMissing?: string;
  /** Pre-seed staging dir with extra stale archive. */
  staleArchiveInStaging?: string;
  /** Pre-seed staging/data/ with a marker file to check preservation. */
  dataMarkerInStaging?: boolean;
}

/**
 * Build a minimal MOTIS config.yml in the format produced by
 * generate-motis-config.py: nested YAML maps, not YAML sequences.
 * `path:` is indented 6 spaces; `osm:` is at top level.
 */
function buildConfig(feeds: string[], osm?: string): string {
  const lines = ["server:", "  port: 8080", "timetable:", "  datasets:"];
  for (const f of feeds) {
    // dataset key = basename without extension (simplified)
    const key = f.replace(/\.(gtfs|netex)\.zip$/i, "").replace(/[^a-zA-Z0-9]/g, "-");
    lines.push(`    ${key}:`, `      path: ${f}`);
  }
  if (osm) lines.push(`osm: ${osm}`);
  return `${lines.join("\n")}\n`;
}

function setupFixture(opts: FixtureOptions): {
  dataDir: string;
  outDir: string;
  stagingDir: string;
  liveDir: string;
} {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-assemble-staging-"));

  const dataDir = tmp;
  const outDir = join(dataDir, "gtfs");
  const stagingDir = join(dataDir, "motis", "staging");
  const liveDir = join(dataDir, "motis", "live");

  mkdirSync(outDir, { recursive: true });
  mkdirSync(liveDir, { recursive: true });

  const feeds = opts.feeds ?? [];
  const osm = opts.osmInLive ?? opts.osmMissing;

  if (opts.withConfig) {
    const configText = buildConfig(feeds, osm);
    writeFileSync(join(outDir, "config.yml"), configText);
  }

  for (const feed of feeds) {
    writeFileSync(join(outDir, feed), `fake-gtfs-data-${feed}`);
  }

  // Create OSM in live dir only when osmInLive is set (not when osmMissing)
  if (opts.osmInLive) {
    writeFileSync(join(liveDir, opts.osmInLive), "fake-osm-data");
  }

  // scripts/ + license.json in outDir (small text files the stage copies)
  const scriptsDir = join(outDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, "coloring.lua"), "-- lua script\n");
  writeFileSync(join(outDir, "license.json"), JSON.stringify({ licenses: [] }));
  const proxyDir = join(outDir, CANDIDATE_PROXY_DIRNAME);
  mkdirSync(join(proxyDir, "conf"), { recursive: true });
  writeFileSync(join(proxyDir, "conf", "default.conf"), "server { listen 80; }\n");
  writeFileSync(join(proxyDir, "feed-proxy-vars.json"), "{}\n");

  if (opts.staleArchiveInStaging) {
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, opts.staleArchiveInStaging), "stale-content");
  }

  if (opts.dataMarkerInStaging) {
    mkdirSync(join(stagingDir, "data"), { recursive: true });
    writeFileSync(join(stagingDir, "data", "tt.bin"), "compiled-timetable");
  }

  return { dataDir, outDir, stagingDir, liveDir };
}

function makeCtx(dataDir: string) {
  return buildJobContext({
    dataDir,
    store: new StateStore(dataDir),
    runner: async () => {
      throw new Error("runner should not be invoked by assemble-staging");
    },
    now: () => "2026-05-01T00:00:00.000Z",
  });
}

// ---------------------------------------------------------------------------
// run() behaviour tests
// ---------------------------------------------------------------------------

describe("assemble-staging run()", () => {
  it("returns status 'skipped' when config.yml is absent from outDir", async () => {
    const fx = setupFixture({});
    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/no config\.yml at/);
    expect(result.message).toMatch(/nothing to assemble/);
  });

  it("happy path: status 'ok', feeds + osm + scripts + license assembled", async () => {
    const feeds = ["region-a.gtfs.zip", "region-b.gtfs.zip"];
    const fx = setupFixture({
      withConfig: true,
      feeds,
      osmInLive: "germany.osm.pbf",
    });
    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("ok");

    // config.yml in staging
    expect(existsSync(join(fx.stagingDir, "config.yml"))).toBe(true);

    // both feed archives present
    for (const feed of feeds) {
      expect(existsSync(join(fx.stagingDir, feed))).toBe(true);
    }

    // OSM extract carried from live dir
    expect(existsSync(join(fx.stagingDir, "germany.osm.pbf"))).toBe(true);

    // scripts/ and license.json
    expect(existsSync(join(fx.stagingDir, "scripts", "coloring.lua"))).toBe(true);
    expect(existsSync(join(fx.stagingDir, "license.json"))).toBe(true);

    // artifacts
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.linkedFeeds).toBe(2);
    expect(artifacts.missingFeeds).toEqual([]);
    expect(artifacts.osmSource).toBe("live");
  });

  it("returns status 'partial' when a referenced feed is missing from outDir", async () => {
    // Set up with one present feed, then overwrite config to also reference a missing one.
    const fx = setupFixture({
      withConfig: true,
      feeds: ["present.gtfs.zip"],
    });
    // Overwrite config to reference a second feed that was never written to disk.
    writeFileSync(
      join(fx.outDir, "config.yml"),
      buildConfig(["present.gtfs.zip", "missing-feed.gtfs.zip"]),
    );

    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("partial");
    const artifacts = result.artifacts as Record<string, unknown>;
    expect((artifacts.missingFeeds as string[]).includes("missing-feed.gtfs.zip")).toBe(true);
  });

  it("returns status 'error' (empty-staging guard) when the config references no feeds", async () => {
    // gen-motis-config with --skip-missing-files emits a config with 0 datasets
    // when nothing was acquired. Staging 0 feeds would import + promote an empty
    // timetable, so the stage must error (it's a hardStop in the pipeline).
    const fx = setupFixture({ withConfig: true, feeds: [] });
    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/refusing to import\/promote an empty timetable/);
    expect((result.artifacts as Record<string, unknown>).linkedFeeds).toBe(0);
  });

  it("returns status 'error' when every referenced feed is missing from output", async () => {
    const fx = setupFixture({ withConfig: true, feeds: [] });
    // Config references a feed that was never written to disk → 0 linked.
    writeFileSync(join(fx.outDir, "config.yml"), buildConfig(["gone.gtfs.zip"]));
    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("error");
    expect((result.artifacts as Record<string, unknown>).missingFeeds).toContain("gone.gtfs.zip");
  });

  it("prunes stale archives in staging dir not referenced by current config", async () => {
    const fx = setupFixture({
      withConfig: true,
      feeds: ["current-feed.gtfs.zip"],
      staleArchiveInStaging: "old-feed.gtfs.zip",
    });

    // Verify stale file is present before run
    expect(existsSync(join(fx.stagingDir, "old-feed.gtfs.zip"))).toBe(true);

    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("ok");

    // Stale archive gone; current feed present
    expect(existsSync(join(fx.stagingDir, "old-feed.gtfs.zip"))).toBe(false);
    expect(existsSync(join(fx.stagingDir, "current-feed.gtfs.zip"))).toBe(true);
  });

  it("preserves pre-existing staging/data/ subdir across assembly (MOTIS import cache)", async () => {
    const fx = setupFixture({
      withConfig: true,
      feeds: ["feed.gtfs.zip"],
      dataMarkerInStaging: true,
    });

    // Marker file must exist before run
    expect(existsSync(join(fx.stagingDir, "data", "tt.bin"))).toBe(true);

    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("ok");

    // data/tt.bin still present and unchanged
    expect(existsSync(join(fx.stagingDir, "data", "tt.bin"))).toBe(true);
    expect(readFileSync(join(fx.stagingDir, "data", "tt.bin"), "utf-8")).toBe("compiled-timetable");
  });

  it("assembled archive has same content as source (hardlink or copy both work)", async () => {
    const feeds = ["content-check.gtfs.zip"];
    const fx = setupFixture({ withConfig: true, feeds });

    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("ok");

    const src = readFileSync(join(fx.outDir, "content-check.gtfs.zip"), "utf-8");
    const dst = readFileSync(join(fx.stagingDir, "content-check.gtfs.zip"), "utf-8");
    expect(src).toBe(dst);
  });

  it("returns status 'partial' when osm is referenced but absent from both outDir and liveDir", async () => {
    const fx = setupFixture({
      withConfig: true,
      feeds: ["feed.gtfs.zip"],
      osmMissing: "nowhere.osm.pbf",
    });

    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("partial");
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.osmSource).toBe("missing");
  });

  it("picks up osm from outDir when it exists there (osmSource = 'out')", async () => {
    const feeds = ["feed.gtfs.zip"];
    const fx = setupFixture({ withConfig: true, feeds });
    // Write config referencing osm, and put the osm file in outDir (not live dir)
    writeFileSync(join(fx.outDir, "config.yml"), buildConfig(feeds, "local.osm.pbf"));
    writeFileSync(join(fx.outDir, "local.osm.pbf"), "osm-data-from-out");

    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("ok");
    const artifacts = result.artifacts as Record<string, unknown>;
    expect(artifacts.osmSource).toBe("out");
    expect(existsSync(join(fx.stagingDir, "local.osm.pbf"))).toBe(true);
  });

  it("does not invoke the runner (no shell-out / Docker dependency)", async () => {
    let runnerInvoked = false;
    tmp = mkdtempSync(join(tmpdir(), "openmapx-assemble-staging-runner-"));
    const dataDir = tmp;

    const outDir = join(dataDir, "gtfs");
    const liveDir = join(dataDir, "motis", "live");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(outDir, "config.yml"), buildConfig(["feed.gtfs.zip"]));
    writeFileSync(join(outDir, "feed.gtfs.zip"), "feed-content");
    writeFileSync(join(outDir, "license.json"), "[]\n");
    const proxyDir = join(outDir, CANDIDATE_PROXY_DIRNAME);
    mkdirSync(join(proxyDir, "conf"), { recursive: true });
    writeFileSync(join(proxyDir, "conf", "default.conf"), "server { listen 80; }\n");
    writeFileSync(join(proxyDir, "feed-proxy-vars.json"), "{}\n");

    const ctx = buildJobContext({
      dataDir,
      store: new StateStore(dataDir),
      runner: async () => {
        runnerInvoked = true;
        throw new Error("runner invoked unexpectedly");
      },
      now: () => "2026-05-01T00:00:00.000Z",
    });

    const result = await run(ctx);
    expect(result.status).toBe("ok");
    expect(runnerInvoked).toBe(false);
  });
});

describe("assemble-staging run() — directory structure", () => {
  it("creates stagingDir when it does not pre-exist, with all expected entries", async () => {
    const feeds = ["new-feed.gtfs.zip"];
    const fx = setupFixture({ withConfig: true, feeds });

    // staging dir does not yet exist before run
    expect(existsSync(fx.stagingDir)).toBe(false);

    const result = await run(makeCtx(fx.dataDir));
    expect(result.status).toBe("ok");
    expect(existsSync(fx.stagingDir)).toBe(true);

    const entries = readdirSync(fx.stagingDir);
    expect(entries).toContain("config.yml");
    expect(entries).toContain("new-feed.gtfs.zip");
    expect(entries).toContain("scripts");
    expect(entries).toContain("license.json");
  });
});
