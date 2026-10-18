import { execFileSync } from "node:child_process";
import {
  chmodSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyApiKeysOverlay,
  pruneUnresolvableSources,
  scheduleSourcesForFeed,
} from "../../src/jobs/transitous/internal.js";
import type { JobLogger } from "../../src/jobs/transitous/types.js";

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

type FeedSource = { name?: string; skip?: boolean; "skip-reason"?: string };

function makeCatalog(sources: Array<Record<string, unknown>>): string {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-prune-"));
  const catalogDir = join(tmp, ".transitous-catalog");
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  writeFileSync(join(catalogDir, "feeds", "us.json"), JSON.stringify({ sources }, null, 2));
  return catalogDir;
}

function readSources(catalogDir: string): FeedSource[] {
  return (
    JSON.parse(readFileSync(join(catalogDir, "feeds", "us.json"), "utf-8")) as {
      sources: FeedSource[];
    }
  ).sources;
}

/** A runner that plays out a scripted sequence of behaviours per invocation. */
function makeRunner(behaviours: Array<"ok" | string>): {
  runCheck: (countries: string[]) => Promise<void>;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const runCheck = async () => {
    const behaviour = behaviours[Math.min(state.calls, behaviours.length - 1)] ?? "ok";
    state.calls += 1;
    if (behaviour !== "ok") {
      throw Object.assign(new Error(behaviour), { stderr: behaviour });
    }
  };
  return { runCheck, state };
}

function silentLogger(): JobLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
    warnings,
  };
}

describe("API-key catalog write security", () => {
  function fixture() {
    const catalogDir = makeCatalog([
      { name: "MBTA", "transitland-atlas-id": "f-mbta", skip: true },
    ]);
    const feedPath = join(catalogDir, "feeds", "us.json");
    chmodSync(feedPath, 0o644);
    const overlayPath = join(catalogDir, "api-keys.json");
    writeFileSync(overlayPath, JSON.stringify({ "us/MBTA": "PLAN119_SYNTHETIC_KEY" }));
    return { catalogDir, feedPath, overlayPath };
  }

  it.each([false, true])(
    "is private before credential bytes, including partial failure=%s",
    (fail) => {
      const { catalogDir, feedPath, overlayPath } = fixture();
      const before = statSync(feedPath);
      const modes: number[] = [];
      let descriptor: number | undefined;
      vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
        if (typeof data === "string" && data.includes("PLAN119_SYNTHETIC_KEY")) {
          const stat = typeof file === "number" ? fstatSync(file) : statSync(file);
          modes.push(stat.mode & 0o777);
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

      if (fail) {
        expect(() => applyApiKeysOverlay(catalogDir, overlayPath)).toThrow(
          "injected catalog write failure",
        );
      } else {
        expect(applyApiKeysOverlay(catalogDir, overlayPath)).toBe(1);
        expect(JSON.parse(readFileSync(feedPath, "utf-8"))).toEqual({
          sources: [
            { name: "MBTA", "transitland-atlas-id": "f-mbta", "api-key": "PLAN119_SYNTHETIC_KEY" },
          ],
        });
      }
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
    (kind) => {
      const { catalogDir, feedPath, overlayPath } = fixture();
      const external = join(catalogDir, "external.json");
      const original = readFileSync(feedPath, "utf-8");
      writeFileSync(external, original, { mode: 0o644 });
      rmSync(feedPath);
      if (kind === "symlink") symlinkSync(external, feedPath);
      else linkSync(external, feedPath);

      expect(() => applyApiKeysOverlay(catalogDir, overlayPath)).toThrow();
      expect(readFileSync(external, "utf-8")).toBe(original);
      expect(statSync(external).mode & 0o777).toBe(0o644);
    },
  );

  it("rejects a final path replaced by a directory before writing", () => {
    const { catalogDir, feedPath, overlayPath } = fixture();
    vi.mocked(readFileSync).mockImplementation((file, options) => {
      const data = actualFs.readFileSync(file, options);
      if (file === feedPath) {
        rmSync(feedPath);
        mkdirSync(feedPath);
      }
      return data;
    });
    expect(() => applyApiKeysOverlay(catalogDir, overlayPath)).toThrow();
    expect(statSync(feedPath).isDirectory()).toBe(true);
  });

  it("rejects an opened FIFO before changing its permissions", () => {
    const { catalogDir, feedPath, overlayPath } = fixture();
    let reader: number | undefined;
    vi.mocked(readFileSync).mockImplementation((file, options) => {
      const data = actualFs.readFileSync(file, options);
      if (file === feedPath) {
        rmSync(feedPath);
        execFileSync("mkfifo", ["-m", "644", feedPath]);
        reader = actualFs.openSync(
          feedPath,
          actualFs.constants.O_RDONLY | actualFs.constants.O_NONBLOCK,
        );
      }
      return data;
    });
    try {
      expect(() => applyApiKeysOverlay(catalogDir, overlayPath)).toThrow(/must be regular/);
      expect(statSync(feedPath).isFIFO()).toBe(true);
      expect(statSync(feedPath).mode & 0o777).toBe(0o644);
    } finally {
      if (reader !== undefined) actualFs.closeSync(reader);
    }
  });
});

describe("scheduleSourcesForFeed", () => {
  it("keeps real schedule source names unchanged", () => {
    const names = ["DELFI", "VBB", "AVV-Aachen", "amarillo-bw", "esel.ac", "PTA-Styria-Flex-2026"];
    const sources = scheduleSourcesForFeed(
      "de",
      "de",
      { sources: names.map((name) => ({ name })) },
      new Map(),
    );

    expect(sources.map((source) => ({ region: source.region, name: source.name }))).toEqual(
      names.map((name) => ({ region: "de", name })),
    );
  });

  it("skips unsafe source names and reports each one", () => {
    const warnings: string[] = [];
    const sources = scheduleSourcesForFeed(
      "de",
      "de",
      {
        sources: [{ name: "../../../evil" }, { name: "a/b" }, { name: ".." }, { name: ".hidden" }],
      },
      new Map(),
      (message) => warnings.push(message),
    );

    expect(sources).toEqual([]);
    expect(warnings).toHaveLength(4);
    expect(warnings.every((warning) => warning.includes("not a safe archive-name component"))).toBe(
      true,
    );
  });

  it("synthesizes a fallback name for a nameless source", () => {
    const sources = scheduleSourcesForFeed("de", "de", { sources: [{}] }, new Map());

    expect(sources[0]?.name).toBe("de_1");
  });

  it("drops an unsafe region and reports it once", () => {
    const warnings: string[] = [];
    const sources = scheduleSourcesForFeed(
      "../de",
      "de",
      { sources: [{ name: "Good" }] },
      new Map(),
      (message) => warnings.push(message),
    );

    expect(sources).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("region is not a safe archive-name component");
  });

  it("continues to exclude GBFS sources", () => {
    const warnings: string[] = [];
    const sources = scheduleSourcesForFeed(
      "de",
      "de",
      { sources: [{ name: "Bikes", spec: "gbfs" }] },
      new Map(),
      (message) => warnings.push(message),
    );

    expect(sources).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("pruneUnresolvableSources", () => {
  it("runs the resolution check once and skips nothing when everything resolves", async () => {
    const catalogDir = makeCatalog([
      { name: "MBTA", type: "transitland-atlas", "transitland-atlas-id": "f-mbta" },
    ]);
    const { runCheck, state } = makeRunner(["ok"]);

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: ["us"],
      runCheck,
      logger: silentLogger(),
    });

    expect(skipped).toEqual([]);
    expect(state.calls).toBe(1);
    expect(readSources(catalogDir).find((s) => s.name === "MBTA")?.skip).toBeUndefined();
  });

  it("skips the source upstream cites by atlas id, then retries until the check passes", async () => {
    const catalogDir = makeCatalog([
      { name: "Metra", type: "transitland-atlas", "transitland-atlas-id": "f-metra" },
      { name: "MBTA", type: "transitland-atlas", "transitland-atlas-id": "f-mbta" },
    ]);
    const { runCheck, state } = makeRunner(["Error: Could not resolve f-metra", "ok"]);

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: ["us"],
      runCheck,
      logger: silentLogger(),
    });

    expect(skipped).toEqual(["f-metra"]);
    expect(state.calls).toBe(2);
    const sources = readSources(catalogDir);
    const metra = sources.find((s) => s.name === "Metra");
    expect(metra?.skip).toBe(true);
    expect(metra?.["skip-reason"]).toMatch(/could not resolve/i);
    expect(sources.find((s) => s.name === "MBTA")?.skip).toBeUndefined();
  });

  it("also matches a mobility-database source by mdb-id", async () => {
    const catalogDir = makeCatalog([
      { name: "Foo", type: "mobility-database", "mdb-id": "mdb-42" },
    ]);
    const { runCheck } = makeRunner(["Error: Could not resolve mdb-42", "ok"]);

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: [],
      runCheck,
      logger: silentLogger(),
    });

    expect(skipped).toEqual(["mdb-42"]);
    expect(readSources(catalogDir).find((s) => s.name === "Foo")?.skip).toBe(true);
  });

  it("stops without failing when the cited id matches no feed source", async () => {
    const catalogDir = makeCatalog([
      { name: "MBTA", type: "transitland-atlas", "transitland-atlas-id": "f-mbta" },
    ]);
    const { runCheck, state } = makeRunner(["Error: Could not resolve f-ghost"]);
    const logger = silentLogger();

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: ["us"],
      runCheck,
      logger,
    });

    expect(skipped).toEqual([]);
    expect(state.calls).toBe(1);
    expect(readSources(catalogDir).find((s) => s.name === "MBTA")?.skip).toBeUndefined();
    expect(logger.warnings.some((w) => w.includes("f-ghost"))).toBe(true);
  });

  it("defers a non-resolution failure to the real gen-motis-config stage", async () => {
    const catalogDir = makeCatalog([
      { name: "MBTA", type: "transitland-atlas", "transitland-atlas-id": "f-mbta" },
    ]);
    const { runCheck, state } = makeRunner([
      "Traceback: ConnectionError downloading mobilitydatabase.csv",
    ]);

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: ["us"],
      runCheck,
      logger: silentLogger(),
    });

    expect(skipped).toEqual([]);
    expect(state.calls).toBe(1);
    expect(readSources(catalogDir).find((s) => s.name === "MBTA")?.skip).toBeUndefined();
  });
});
