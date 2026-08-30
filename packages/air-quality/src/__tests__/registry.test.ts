import { afterEach, describe, expect, it } from "vitest";
import {
  type StandardAdapter,
  type StandardSourceManifest,
  standardSourceManifestSchema,
} from "../standards/adapter";
import {
  clearStandardRegistryForTests,
  registerStandardAdapter,
  resolveStandard,
} from "../standards/registry";

const manifest: StandardSourceManifest = {
  standardId: "us-epa-2024",
  resolvedRevision: "revision-1",
  retrievedAt: "2026-08-30",
  effectiveFrom: "2024-05-06T00:00:00Z",
  effectiveUntil: null,
  sources: [
    { url: "https://www.epa.gov/example", title: "Official source", anchors: ["Table 6, page 14"] },
  ],
  transcriptionChecksum: `sha256:${"a".repeat(64)}`,
  independentDerivation: {
    reviewer: "fixture-reviewer",
    reviewedAt: "2026-08-30",
    note: "Derived independently from Table 6.",
  },
};

function adapter(update: Partial<StandardAdapter> = {}): StandardAdapter {
  return {
    standardId: "us-epa-2024",
    methodId: "epa-aqi",
    revision: "revision-1",
    effectiveFrom: "2024-05-06T00:00:00Z",
    effectiveUntil: null,
    supportedModes: new Set(["current", "history"]),
    categories: [
      {
        id: "good",
        labelKey: "airQuality.category.good",
        minimum: 0,
        maximum: 50,
        color: "#00e400",
      },
    ],
    sourceManifest: manifest,
    summarizeCompleteness: () => ({
      passes: true,
      missingRequirements: [],
      qualifyingPollutants: ["pm25"],
    }),
    ...update,
  };
}

afterEach(clearStandardRegistryForTests);

describe("standard source manifests", () => {
  it("requires provenance, revision, anchors, checksum, independent review, and category localization", () => {
    expect(standardSourceManifestSchema.safeParse(manifest).success).toBe(true);
    for (const update of [
      { sources: [] },
      { transcriptionChecksum: "not-a-checksum" },
      { independentDerivation: { ...manifest.independentDerivation, reviewer: "" } },
      { effectiveFrom: "not-an-instant" },
    ])
      expect(standardSourceManifestSchema.safeParse({ ...manifest, ...update }).success).toBe(
        false,
      );
    expect(() =>
      registerStandardAdapter(
        adapter({
          categories: [{ id: "good", labelKey: "", minimum: 0, maximum: 50, color: "#00e400" }],
        }),
      ),
    ).toThrow();
  });

  it("selects only the revision effective at the evidence time", () => {
    registerStandardAdapter(
      adapter({
        effectiveUntil: "2025-01-01T00:00:00Z",
        sourceManifest: { ...manifest, effectiveUntil: "2025-01-01T00:00:00Z" },
      }),
    );
    registerStandardAdapter(
      adapter({
        revision: "revision-2",
        effectiveFrom: "2025-02-01T00:00:00Z",
        sourceManifest: {
          ...manifest,
          resolvedRevision: "revision-2",
          effectiveFrom: "2025-02-01T00:00:00Z",
        },
      }),
    );
    expect(resolveStandard("us-epa-2024", "2024-09-01T00:00:00Z")).toMatchObject({
      ok: true,
      resolvedRevision: "revision-1",
      cacheTag: "us-epa-2024@revision-1",
    });
    expect(resolveStandard("us-epa-2024", "2025-01-15T00:00:00Z")).toEqual({
      ok: false,
      reason: "historical_gap",
      requestedId: "us-epa-2024",
    });
    expect(resolveStandard("unknown", "2026-01-01T00:00:00Z")).toEqual({
      ok: false,
      reason: "unknown_standard",
      requestedId: "unknown",
    });
  });

  it("rejects duplicate revisions and mismatched manifest identities", () => {
    registerStandardAdapter(adapter());
    expect(() => registerStandardAdapter(adapter())).toThrow(/Duplicate/);
    expect(() =>
      registerStandardAdapter(
        adapter({ sourceManifest: { ...manifest, resolvedRevision: "wrong" } }),
      ),
    ).toThrow(/revision/);
    expect(() =>
      registerStandardAdapter(adapter({ effectiveFrom: "2025-01-01T00:00:00Z" })),
    ).toThrow(/effective interval/);
  });

  it("rejects overlapping effective revisions", () => {
    registerStandardAdapter(adapter());
    expect(() =>
      registerStandardAdapter(
        adapter({
          revision: "revision-2",
          effectiveFrom: "2025-02-01T00:00:00Z",
          sourceManifest: {
            ...manifest,
            resolvedRevision: "revision-2",
            effectiveFrom: "2025-02-01T00:00:00Z",
          },
        }),
      ),
    ).toThrow(/overlap/);
  });
});
