import { describe, expect, it } from "vitest";
import { decodeGbfsCatalogLock, decodeTransitousLock, parseRefShaPair } from "../src/index.js";

const GBFS = {
  schemaVersion: 1 as const,
  source: "mobilitydata-gbfs" as const,
  commit: "a".repeat(40),
  url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"a".repeat(40)}/systems.csv`,
  sha256: "b".repeat(64),
  lockedAt: "2026-01-01T00:00:00Z",
  lockedBy: "test",
};

describe("decodeGbfsCatalogLock", () => {
  it("accepts an immutable commit URL and hash", () => {
    expect(decodeGbfsCatalogLock({ $schema: "./x.json", ...GBFS })).toEqual(GBFS);
  });

  it("rejects a mutable or mismatched URL", () => {
    expect(() =>
      decodeGbfsCatalogLock({ ...GBFS, url: "https://example.test/master/systems.csv" }),
    ).toThrow(/not pinned/);
  });
});

describe("decodeTransitousLock", () => {
  it("requires the ref, submodules and who locked it", () => {
    expect(() => decodeTransitousLock({ submodules: {} })).toThrow(/"ref"/);
    expect(() => decodeTransitousLock({ ref: "main@abc1234", submodules: { atlas: 1 } })).toThrow(
      /not a string SHA/,
    );
  });
});

describe("parseRefShaPair", () => {
  it("splits a valid <branch>@<sha> ref", () => {
    expect(parseRefShaPair("main@099af198526dc192dd294a100ca4db29477e9133")).toEqual({
      branch: "main",
      sha: "099af198526dc192dd294a100ca4db29477e9133",
    });
  });

  it("rejects a ref without an @ separator or with a non-hex SHA", () => {
    expect(() => parseRefShaPair("main")).toThrow(/expected/);
    expect(() => parseRefShaPair("main@zzz")).toThrow(/hex/);
  });
});
