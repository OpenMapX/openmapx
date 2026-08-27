import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  pruneUnresolvableSources,
  scheduleSourcesForFeed,
} from "../../src/jobs/transitous/internal.js";
import type { JobLogger } from "../../src/jobs/transitous/types.js";

let tmp: string | undefined;

afterEach(() => {
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
