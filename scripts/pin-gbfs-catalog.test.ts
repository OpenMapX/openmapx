import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGbfsCandidate, writeGbfsCatalogPin } from "./pin-gbfs-catalog";

let temporaryRoot: string | undefined;
afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

const LOCK = {
  schemaVersion: 1 as const,
  source: "mobilitydata-gbfs" as const,
  commit: "c".repeat(40),
  url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"c".repeat(40)}/systems.csv`,
  sha256: "d".repeat(64),
  lockedAt: "2026-07-15T00:00:00.000Z",
  lockedBy: "test",
};

/** A checkout with the lock and the constant it is paired with. */
function checkout() {
  temporaryRoot = mkdtempSync(join(tmpdir(), "openmapx-gbfs-pin-"));
  mkdirSync(join(temporaryRoot, "infra", "docker"), { recursive: true });
  mkdirSync(join(temporaryRoot, "packages", "transitous-core", "src"), { recursive: true });
  const lock = join(temporaryRoot, "infra", "docker", "gbfs-catalog.lock.json");
  const constants = join(temporaryRoot, "packages", "transitous-core", "src", "constants.ts");
  writeFileSync(lock, "old-lock\n");
  writeFileSync(
    constants,
    `export const OTHER = 1;\nexport const MOBILITYDATA_GBFS_CATALOG_COMMIT = "${"a".repeat(40)}";\n`,
  );
  return { root: temporaryRoot, lock, constants };
}

describe("the GBFS registry pin", () => {
  it("resolves the immutable registry, its hash, and country counts", async () => {
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

  it("rewrites the lock and the compiled commit together", () => {
    const { root, lock, constants } = checkout();
    writeGbfsCatalogPin(root, LOCK);
    expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ commit: LOCK.commit });
    expect(readFileSync(constants, "utf8")).toBe(
      `export const OTHER = 1;\nexport const MOBILITYDATA_GBFS_CATALOG_COMMIT = "${LOCK.commit}";\n`,
    );
  });

  it("restores both files if the second replacement fails", () => {
    const { root, lock, constants } = checkout();
    const before = readFileSync(constants, "utf8");
    let renames = 0;
    expect(() =>
      writeGbfsCatalogPin(root, LOCK, {
        rename: (from, to) => {
          renames += 1;
          if (renames === 2) throw new Error("injected rename failure");
          return renameSync(from, to);
        },
      }),
    ).toThrow(/previous files restored/);
    expect(readFileSync(lock, "utf8")).toBe("old-lock\n");
    expect(readFileSync(constants, "utf8")).toBe(before);
  });
});
