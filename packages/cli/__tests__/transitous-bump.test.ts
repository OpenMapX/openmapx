import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  combinedPinsAreCurrent,
  diffFeedFiles,
  resolveGbfsCandidate,
  writeCombinedCatalogLockProposal,
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

  it("includes same-name endpoint and attribution changes in the review", () => {
    const oldFeeds = new Map([
      [
        "de",
        {
          sources: [
            {
              name: "BVG",
              url: "https://old.test/feed",
              attribution: { text: "Original operator" },
            },
          ],
        },
      ],
    ]);
    const newFeeds = new Map([
      [
        "de",
        {
          sources: [
            { name: "BVG", url: "https://new.test/feed", attribution: { text: "New operator" } },
          ],
        },
      ],
    ]);
    expect(diffFeedFiles(oldFeeds, newFeeds).modifiedRegions).toEqual(["de"]);
  });

  it("bounds upstream commit metadata before it can become a proposal", async () => {
    const fetchStub = async (input: string | URL | Request) =>
      String(input).includes("api.github.com")
        ? new Response(" ".repeat(65536) + JSON.stringify({ sha: "e".repeat(40) }))
        : new Response(
            "Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL\n",
          );
    await expect(resolveGbfsCandidate("fixture", fetchStub as typeof fetch)).rejects.toThrow(
      /byte limit/,
    );
  });

  it("detects a no-op only when both compatible pins match", () => {
    expect(combinedPinsAreCurrent(TRANSITOUS, GBFS, "a".repeat(40), "c".repeat(40))).toBe(true);
    expect(combinedPinsAreCurrent(TRANSITOUS, GBFS, "a".repeat(40), "f".repeat(40))).toBe(false);
  });

  it("refuses unvalidated direct activation before replacing either compatibility file", () => {
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
    ).toThrow(/validated paired approval/);
    expect(renameCalls).toBe(0);
    expect(readFileSync(transitousPath, "utf-8")).toBe("old-transitous\n");
    expect(readFileSync(gbfsPath, "utf-8")).toBe("old-gbfs\n");
  });

  it("reports removed feeds and license changes for compatibility review", () => {
    const summary = diffFeedFiles(
      new Map([
        [
          "de",
          {
            sources: [
              { name: "BVG", license: { "spdx-identifier": "CC-BY-4.0" } },
              { name: "Removed" },
            ],
          },
        ],
      ]),
      new Map([["de", { sources: [{ name: "BVG", license: { "spdx-identifier": "ODbL-1.0" } }] }]]),
    );
    expect(summary.removedSources).toBe(1);
    expect(summary.licenseChanges).toEqual([{ region: "de", source: "BVG" }]);
  });

  it("refuses obsolete unsigned proposal file writes", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "openmapx-bump-proposal-"));
    const directory = join(temporaryRoot, "infra", "docker");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "transitous.lock.json"), "active-transitous\n");
    writeFileSync(join(directory, "gbfs-catalog.lock.json"), "active-gbfs\n");
    expect(() => writeCombinedCatalogLockProposal(temporaryRoot!, TRANSITOUS, GBFS)).toThrow(
      /installed paired review/,
    );
    expect(readFileSync(join(directory, "transitous.lock.json"), "utf-8")).toBe(
      "active-transitous\n",
    );
    expect(readFileSync(join(directory, "gbfs-catalog.lock.json"), "utf-8")).toBe("active-gbfs\n");
  });
});

it("delegates a CLI bump to the actual paired proposal HTTP operation", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const bytes of request) body += bytes;
    calls.push({ url: request.url!, body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        unchanged: false,
        proposed: true,
        proposalId: "00000000-0000-4000-8000-000000000001",
        catalogRevisionId: "e".repeat(64),
        ref: TRANSITOUS.ref,
        previousRef: TRANSITOUS.ref,
        submoduleSha: TRANSITOUS.submodules["transitland-atlas"],
        lockedAt: TRANSITOUS.lockedAt,
        lockedBy: "catalog-review",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const previous = process.env.DATA_MANAGER_URL;
  process.env.DATA_MANAGER_URL = `http://127.0.0.1:${port}`;
  try {
    const { proposeReviewedCatalog } = await import("../src/commands/transitous-bump");
    const result = await proposeReviewedCatalog("main");
    expect(result).toMatchObject({
      proposed: true,
      proposalId: "00000000-0000-4000-8000-000000000001",
    });
    expect(calls).toEqual([{ url: "/transit/bump", body: { branch: "main" } }]);
  } finally {
    if (previous === undefined) delete process.env.DATA_MANAGER_URL;
    else process.env.DATA_MANAGER_URL = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
