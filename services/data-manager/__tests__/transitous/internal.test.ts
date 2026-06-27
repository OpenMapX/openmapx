import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneUnresolvableSources } from "../../src/jobs/transitous/internal.js";
import type { CommandRunner, JobLogger } from "../../src/jobs/transitous/types.js";

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
  runner: CommandRunner;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const runner: CommandRunner = async () => {
    const behaviour = behaviours[Math.min(state.calls, behaviours.length - 1)] ?? "ok";
    state.calls += 1;
    if (behaviour !== "ok") {
      throw Object.assign(new Error(behaviour), { stderr: behaviour });
    }
  };
  return { runner, state };
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

describe("pruneUnresolvableSources", () => {
  it("runs the resolution check once and skips nothing when everything resolves", async () => {
    const catalogDir = makeCatalog([
      { name: "MBTA", type: "transitland-atlas", "transitland-atlas-id": "f-mbta" },
    ]);
    const { runner, state } = makeRunner(["ok"]);

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: ["us"],
      runner,
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
    const { runner, state } = makeRunner(["Error: Could not resolve f-metra", "ok"]);

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: ["us"],
      runner,
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
    const { runner } = makeRunner(["Error: Could not resolve mdb-42", "ok"]);

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: [],
      runner,
      logger: silentLogger(),
    });

    expect(skipped).toEqual(["mdb-42"]);
    expect(readSources(catalogDir).find((s) => s.name === "Foo")?.skip).toBe(true);
  });

  it("stops without failing when the cited id matches no feed source", async () => {
    const catalogDir = makeCatalog([
      { name: "MBTA", type: "transitland-atlas", "transitland-atlas-id": "f-mbta" },
    ]);
    const { runner, state } = makeRunner(["Error: Could not resolve f-ghost"]);
    const logger = silentLogger();

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: ["us"],
      runner,
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
    const { runner, state } = makeRunner([
      "Traceback: ConnectionError downloading mobilitydatabase.csv",
    ]);

    const skipped = await pruneUnresolvableSources({
      catalogDir,
      countries: ["us"],
      runner,
      logger: silentLogger(),
    });

    expect(skipped).toEqual([]);
    expect(state.calls).toBe(1);
    expect(readSources(catalogDir).find((s) => s.name === "MBTA")?.skip).toBeUndefined();
  });
});
