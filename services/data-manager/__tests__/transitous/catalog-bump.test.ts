import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CatalogBumpError,
  type CommandRunner,
  candidateMatchesLock,
  lockFromCandidate,
  resolveCatalogBumpCandidate,
} from "../../src/jobs/transitous/catalog-bump.js";
import type { TransitousLock } from "../../src/transitous-lock.js";

const SHA_A = "a".repeat(40);
const SHA_ATLAS = "b".repeat(40);

function clonedCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-catalog-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A runner that returns canned git output keyed by the sub-command. */
function fakeRunner(overrides: Partial<Record<string, string>> = {}): CommandRunner {
  return async (_file, args) => {
    if (args.includes("fetch")) return { stdout: "" };
    if (args.includes("rev-parse")) return { stdout: overrides["rev-parse"] ?? SHA_A };
    if (args.includes("ls-tree"))
      return { stdout: overrides["ls-tree"] ?? `160000 commit ${SHA_ATLAS}\ttransitland-atlas\n` };
    return { stdout: "" };
  };
}

describe("resolveCatalogBumpCandidate", () => {
  it("resolves the transitous ref and transitland-atlas submodule SHA", async () => {
    const catalogDir = clonedCatalog();
    dirs.push(catalogDir);
    const candidate = await resolveCatalogBumpCandidate({
      catalogDir,
      branch: "main",
      runner: fakeRunner(),
    });
    expect(candidate).toEqual({
      branch: "main",
      ref: `main@${SHA_A}`,
      transitousSha: SHA_A,
      transitlandAtlasSha: SHA_ATLAS,
    });
  });

  it("defaults to the main branch", async () => {
    const catalogDir = clonedCatalog();
    dirs.push(catalogDir);
    const candidate = await resolveCatalogBumpCandidate({ catalogDir, runner: fakeRunner() });
    expect(candidate.branch).toBe("main");
    expect(candidate.ref).toBe(`main@${SHA_A}`);
  });

  it("throws catalog-not-cloned when the catalog has no .git", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-nocatalog-"));
    dirs.push(dir);
    await expect(
      resolveCatalogBumpCandidate({ catalogDir: dir, runner: fakeRunner() }),
    ).rejects.toMatchObject({ code: "catalog-not-cloned" });
  });

  it("throws git-fetch-failed when fetch errors", async () => {
    const catalogDir = clonedCatalog();
    dirs.push(catalogDir);
    const runner: CommandRunner = async (_file, args) => {
      if (args.includes("fetch")) throw new Error("network down");
      return { stdout: "" };
    };
    await expect(resolveCatalogBumpCandidate({ catalogDir, runner })).rejects.toMatchObject({
      code: "git-fetch-failed",
    });
  });

  it("throws submodule-resolution-failed on an unparseable ls-tree", async () => {
    const catalogDir = clonedCatalog();
    dirs.push(catalogDir);
    await expect(
      resolveCatalogBumpCandidate({
        catalogDir,
        runner: fakeRunner({ "ls-tree": "not-a-submodule-line\n" }),
      }),
    ).rejects.toMatchObject({ code: "submodule-resolution-failed" });
  });
});

describe("candidateMatchesLock", () => {
  const candidate = {
    branch: "main",
    ref: `main@${SHA_A}`,
    transitousSha: SHA_A,
    transitlandAtlasSha: SHA_ATLAS,
  };

  it("is false when there is no active lock", () => {
    expect(candidateMatchesLock(candidate, null)).toBe(false);
  });

  it("is true when the lock already pins both SHAs", () => {
    const lock: TransitousLock = {
      ref: `main@${SHA_A}`,
      submodules: { "transitland-atlas": SHA_ATLAS },
      lockedAt: "2026-01-01T00:00:00Z",
      lockedBy: "test",
    };
    expect(candidateMatchesLock(candidate, lock)).toBe(true);
  });

  it("is false when the submodule SHA differs even if the ref matches", () => {
    const lock: TransitousLock = {
      ref: `main@${SHA_A}`,
      submodules: { "transitland-atlas": "c".repeat(40) },
      lockedAt: "2026-01-01T00:00:00Z",
      lockedBy: "test",
    };
    expect(candidateMatchesLock(candidate, lock)).toBe(false);
  });
});

describe("lockFromCandidate", () => {
  it("builds a TransitousLock carrying the ref, submodule, and metadata", () => {
    const lock = lockFromCandidate(
      {
        branch: "main",
        ref: `main@${SHA_A}`,
        transitousSha: SHA_A,
        transitlandAtlasSha: SHA_ATLAS,
      },
      "auto-bump",
      "why",
    );
    expect(lock.ref).toBe(`main@${SHA_A}`);
    expect(lock.submodules["transitland-atlas"]).toBe(SHA_ATLAS);
    expect(lock.lockedBy).toBe("auto-bump");
    expect(lock.comment).toBe("why");
    expect(typeof lock.lockedAt).toBe("string");
  });
});

describe("CatalogBumpError", () => {
  it("carries a machine-readable code", () => {
    const err = new CatalogBumpError("git-fetch-failed", "boom");
    expect(err.code).toBe("git-fetch-failed");
    expect(err.message).toBe("boom");
    expect(err).toBeInstanceOf(Error);
  });
});
