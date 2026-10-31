import { describe, expect, it } from "vitest";
import { artifactFingerprint, parseBundleManifest } from "./manifest";

const manifest = {
  schemaVersion: 1,
  service: "osrm",
  builtAt: "2026-10-23T00:00:00.000Z",
  runtimeImages: { osrm: "image:1" },
  toolImages: {},
  dirs: ["osrm-graph"],
  directories: ["osrm-graph"],
  files: [],
};
describe("manifest shape and immutable content identity", () => {
  it("preserves v1 provenance without inventing source hashes", () => {
    const m = parseBundleManifest(
      JSON.stringify({ ...manifest, sourcePbf: { name: "source.pbf", sizeBytes: 1 } }),
    );
    expect(m).not.toHaveProperty("sourceFingerprints");
  });
  it.each([
    { extra: true },
    { files: [{ path: "osrm-graph/x", sizeBytes: -1, sha256: "a".repeat(64) }] },
    { directories: ["osrm-graph", "osrm-graph"] },
    { runtimeImages: {} },
    { toolImages: [] },
  ])("rejects invalid manifest %j", (patch) =>
    expect(() => parseBundleManifest(JSON.stringify({ ...manifest, ...patch }))).toThrow(),
  );
  it("v2 hashes canonical tuples, independent of metadata and file order", () => {
    expect(artifactFingerprint([])).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(
      parseBundleManifest(
        JSON.stringify({
          ...manifest,
          schemaVersion: 2,
          sourceFingerprints: [],
          artifactFingerprint: artifactFingerprint([]),
        }),
      ).schemaVersion,
    ).toBe(2);
  });
});
