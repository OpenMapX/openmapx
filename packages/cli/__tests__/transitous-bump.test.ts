import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  combinedPinsAreCurrent,
  resolveGbfsCandidate,
  writeCombinedCatalogLocks,
} from "../src/commands/transitous-bump.js";

let temporaryRoot: string | undefined;

afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

const TRANSITOUS = {
  ref: `main@${"a".repeat(40)}`,
  submodules: { "transitland-atlas": "b".repeat(40) },
  lockedAt: "2026-07-15T00:00:00.000Z",
  lockedBy: "test",
};

const GBFS = {
  schemaVersion: 1 as const,
  source: "mobilitydata-gbfs" as const,
  commit: "c".repeat(40),
  url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"c".repeat(40)}/systems.csv`,
  sha256: "d".repeat(64),
  lockedAt: "2026-07-15T00:00:00.000Z",
  lockedBy: "test",
};

describe("Transitous combined catalog bump", () => {
  it("pins the resolved immutable registry, hash, and country counts", async () => {
    const csv =
      "Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL\nDE,One,Berlin,one,https://one.test,https://one.test/gbfs.json,2.3,\nAT,Two,Vienna,two,https://two.test,https://two.test/gbfs.json,3.0,\n";
    const sha = "e".repeat(40);
    const fetchStub = async (input: string | URL | Request): Promise<Response> =>
      String(input).includes("api.github.com")
        ? new Response(JSON.stringify({ sha }))
        : new Response(csv);
    const result = await resolveGbfsCandidate(
      "tester",
      fetchStub as typeof fetch,
      () => new Date("2026-07-15T12:00:00.000Z"),
    );
    expect(result.lock).toMatchObject({
      commit: sha,
      url: `https://raw.githubusercontent.com/MobilityData/gbfs/${sha}/systems.csv`,
      sha256: createHash("sha256").update(csv).digest("hex"),
      lockedAt: "2026-07-15T12:00:00.000Z",
    });
    expect(Object.fromEntries(result.countryCounts)).toEqual({ de: 1, at: 1 });
  });

  it("detects a no-op only when both compatible pins match", () => {
    expect(combinedPinsAreCurrent(TRANSITOUS, GBFS, "a".repeat(40), "c".repeat(40))).toBe(true);
    expect(combinedPinsAreCurrent(TRANSITOUS, GBFS, "a".repeat(40), "f".repeat(40))).toBe(false);
  });

  it("restores both previous locks if replacement fails midway", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "openmapx-bump-lockset-"));
    const directory = join(temporaryRoot, "infra", "docker");
    mkdirSync(directory, { recursive: true });
    const transitousPath = join(directory, "transitous.lock.json");
    const gbfsPath = join(directory, "gbfs-catalog.lock.json");
    writeFileSync(transitousPath, "old-transitous\n");
    writeFileSync(gbfsPath, "old-gbfs\n");
    let renameCalls = 0;
    expect(() =>
      writeCombinedCatalogLocks(temporaryRoot as string, TRANSITOUS, GBFS, {
        rename: (from, to) => {
          renameCalls++;
          if (renameCalls === 2) throw new Error("injected rename failure");
          return renameSync(from, to);
        },
      }),
    ).toThrow(/previous pins restored/);
    expect(readFileSync(transitousPath, "utf-8")).toBe("old-transitous\n");
    expect(readFileSync(gbfsPath, "utf-8")).toBe("old-gbfs\n");
  });
});
