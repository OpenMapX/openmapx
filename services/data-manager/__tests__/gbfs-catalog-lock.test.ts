import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeGbfsCatalogLock,
  readGbfsCatalogLock,
  writeGbfsCatalogLock,
} from "../src/gbfs-catalog-lock.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const LOCK = {
  schemaVersion: 1 as const,
  source: "mobilitydata-gbfs" as const,
  commit: "a".repeat(40),
  url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"a".repeat(40)}/systems.csv`,
  sha256: "b".repeat(64),
  lockedAt: "2026-01-01T00:00:00Z",
  lockedBy: "test",
};

describe("GBFS catalog lock", () => {
  it("roundtrips an immutable commit URL and hash", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-gbfs-lock-"));
    mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
    writeGbfsCatalogLock(tmp, LOCK);
    expect(readGbfsCatalogLock(tmp)).toEqual(LOCK);
    expect(readFileSync(join(tmp, "infra", "docker", "gbfs-catalog.lock.json"), "utf-8")).toContain(
      LOCK.sha256,
    );
  });

  it("rejects a mutable or mismatched URL", () => {
    expect(() =>
      decodeGbfsCatalogLock({ ...LOCK, url: "https://example.test/master/systems.csv" }),
    ).toThrow(/not pinned/);
  });
});
