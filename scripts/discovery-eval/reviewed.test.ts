import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nth } from "../fixtures/nth.js";
import {
  assessObservation,
  buildReviewedEvidence,
  compareAssessments,
  compareReviewedEvidence,
  type Manifest,
  REVIEWED_CASES,
  readManifest,
  validReviewedEvidence,
} from "./reviewed.js";

const reviewedCase = (id: string) => {
  const entry = REVIEWED_CASES.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`No reviewed case ${id}`);
  return entry;
};
const branch = () => reviewedCase("business/rewe-invalidenstrasse");
const firstObservation = (value: Manifest) => nth(value.observations, 0);
const observed = (label: string, coordinates: [number, number]) => ({
  label,
  coordinates,
  closed: false,
});
const context: Manifest["context"] = {
  queryOrder: ["business/rewe-invalidenstrasse"],
  cacheIsolation: "unknown",
  region: "Germany: Berlin, Aachen, Neuss, Monschau",
  extractDate: { value: null, reason: "Exact deployed extract dates are not exposed" },
  style: { value: null, reason: "Not captured in this API-only observation" },
  deployment: { value: null, reason: "Public deployment does not expose its commit" },
  sources: {
    osm: { value: null, reason: "No extract checksum exposed" },
    overture: { value: null, reason: "No deployed generation exposed" },
  },
  provider: { id: "geocoding-maptiler", capabilities: ["autocomplete"] },
  configuration: { language: "en", theme: "dark", viewport: [430, 932], dpr: 1 },
};
const manifest = (): Manifest => ({
  version: 1,
  assessedAt: "2026-10-07T18:00:00Z",
  assessor: "Codex assisted review",
  context,
  observations: [
    {
      caseId: "business/rewe-invalidenstrasse",
      layer: "provider",
      stage: "raw-upstream",
      kind: "live",
      cache: "uncontrolled",
      results: [observed("REWE", [13.3970838, 52.5319807])],
      measurements: { requests: 1, latencyMs: 500, usefulLabels: null, overlaps: null },
    },
  ],
});

describe("independently reviewed discovery observations", () => {
  it("rejects a different same-brand branch instead of accepting its name", () => {
    const result = assessObservation(branch(), {
      ...firstObservation(manifest()),
      results: [observed("REWE", [13.3893156, 52.525331])],
    });
    expect(result.metrics).toMatchObject({ recall: 0, firstRank: null, wrongBranch: 1 });
    expect(result.status).toBe("failed");
  });

  it("retains two independently expected tenants at the same mall address", () => {
    const entry = reviewedCase("business/alexa-tenants");
    const observation = {
      ...firstObservation(manifest()),
      caseId: entry.id,
      results: [observed("MediaMarkt", [13.41479, 52.51986])],
    };
    expect(assessObservation(entry, observation).metrics.recall).toBe(0.5);
    expect(
      assessObservation(entry, {
        ...observation,
        results: [...observation.results, observed("EDEKA Moch", [13.41479, 52.51986])],
      }).status,
    ).toBe("passed");
  });

  it("counts a missing independently verified business, not its street address, as a miss", () => {
    const entry = reviewedCase("business/edeka-alexa");
    expect(
      assessObservation(entry, {
        ...firstObservation(manifest()),
        caseId: entry.id,
        results: [observed("Grunerstraße", [13.41479, 52.51986])],
      }).metrics.recall,
    ).toBe(0);
  });

  it("detects reappearance of a dated permanently closed business", () => {
    const entry = reviewedCase("business/sealife-closed");
    const observation = { ...firstObservation(manifest()), caseId: entry.id, results: [] };
    expect(assessObservation(entry, observation).status).toBe("passed");
    expect(
      assessObservation(entry, {
        ...observation,
        results: [observed("SEA LIFE Berlin", [13.4028, 52.5203])],
      }).metrics.forbiddenHits,
    ).toBe(1);
    expect(
      assessObservation(entry, {
        ...observation,
        results: [observed("SEA LIFE Berlin", [13.4028, 52.5203])],
      }).status,
    ).toBe("failed");
  });

  it("keeps uncontrolled-cache timing measurable without claiming it is a warm-cache result", () => {
    const result = assessObservation(branch(), firstObservation(manifest()));
    expect(result.metrics.latencyMs).toBe(500);
    expect(result.cache).toBe("uncontrolled");
    expect(
      assessObservation(branch(), {
        ...firstObservation(manifest()),
        cache: "warm",
        measurements: { requests: 1, latencyMs: 60000, usefulLabels: null, overlaps: null },
      }).status,
    ).toBe("failed");
  });

  it("requires explicit reasons for unknown revisions and rejects arbitrary configuration", () => {
    expect(readManifest(manifest()).context.deployment.value).toBeNull();
    expect(() =>
      readManifest({ ...manifest(), context: { ...context, deployment: { value: null } } }),
    ).toThrow("manifest");
    expect(() =>
      readManifest({
        ...manifest(),
        context: { ...context, configuration: { ...context.configuration, apiKey: "secret" } },
      }),
    ).toThrow("manifest");
  });

  it("rejects duplicate case/layer observations and unrecognized cases", () => {
    const value = manifest();
    expect(() =>
      readManifest({ ...value, observations: [...value.observations, ...value.observations] }),
    ).toThrow("manifest");
    expect(() =>
      readManifest({
        ...value,
        observations: [{ ...firstObservation(value), caseId: "invented" }],
      }),
    ).toThrow("manifest");
  });

  it("reports numerical rank deterioration even while both results remain within budget", () => {
    const value = readManifest(manifest());
    const before = assessObservation(branch(), firstObservation(value));
    const after = assessObservation(branch(), {
      ...firstObservation(value),
      results: [
        observed("Some unrelated business", [13.4, 52.52]),
        ...firstObservation(value).results,
      ],
    });
    expect(compareAssessments([before], [after]).changes).toContainEqual({
      caseId: "business/rewe-invalidenstrasse",
      layer: "provider",
      metric: "firstRank",
      before: 1,
      after: 2,
    });
  });

  it("retains explicit unavailable layers rather than inventing upstream or installed runtime evidence", () => {
    const result = buildReviewedEvidence(readManifest(manifest()));
    expect(result.results[0]?.metrics.firstRank).toBe(1);
    expect(result.unavailable).toContainEqual({
      caseId: "business/rewe-invalidenstrasse",
      layer: "data",
    });
    expect(result.unavailable).toContainEqual({
      caseId: "business/rewe-invalidenstrasse",
      layer: "runtime",
    });
  });

  it("separates changed source configuration and changed provider results from application-only evidence", () => {
    const before = buildReviewedEvidence(readManifest(manifest()));
    const changed = manifest();
    changed.context = {
      ...context,
      sources: { ...context.sources, osm: { value: "OSM extract 2026-10-06", reason: null } },
    };
    const after = buildReviewedEvidence(readManifest(changed));
    expect(compareReviewedEvidence(before, after).contextChanged).toBe(true);
    const missing = manifest();
    firstObservation(missing).results = [];
    expect(
      compareReviewedEvidence(before, buildReviewedEvidence(readManifest(missing)))
        .changedProviderInputs,
    ).toContain("business/rewe-invalidenstrasse/provider");
  });

  it("detects removal of previously present evidence", () => {
    const before = buildReviewedEvidence(readManifest(manifest()));
    const after = buildReviewedEvidence(readManifest({ ...manifest(), observations: [] }));
    expect(compareReviewedEvidence(before, after).regressions).toContain(
      "business/rewe-invalidenstrasse/provider",
    );
  });
  it("accepts explicitly closed historical listings without treating them as operating businesses", () => {
    const entry = reviewedCase("business/sealife-closed");
    expect(
      assessObservation(entry, {
        ...firstObservation(manifest()),
        caseId: entry.id,
        results: [{ ...observed("SEA LIFE Berlin", [13.4028, 52.5203]), closed: true }],
      }).status,
    ).toBe("passed");
  });

  it("does not fail a correct selected branch because later alternatives include other branches", () => {
    expect(
      assessObservation(branch(), {
        ...firstObservation(manifest()),
        results: [
          observed("REWE", [13.3970838, 52.5319807]),
          observed("REWE", [13.3893156, 52.525331]),
        ],
      }).status,
    ).toBe("passed");
  });

  it("scores a browsing landmark anywhere in the visible set, not by arbitrary feature order", () => {
    const entry = reviewedCase("browsing/berlin-z15");
    const observation = {
      ...firstObservation(manifest()),
      caseId: entry.id,
      layer: "presentation" as const,
      stage: "final-ui" as const,
      results: [
        ...Array.from({ length: 5 }, () => observed("Unrelated", [13.4, 52.52])),
        observed("Berlin Cathedral", [13.401094, 52.519084]),
      ],
      measurements: { requests: null, latencyMs: null, usefulLabels: 6, overlaps: 0 },
    };
    expect(assessObservation(entry, observation).status).toBe("passed");
  });

  it("rejects mismatched observations and fractional count measurements", () => {
    expect(() =>
      assessObservation(branch(), {
        ...firstObservation(manifest()),
        caseId: "business/edeka-alexa",
      }),
    ).toThrow("case");
    const value = manifest();
    firstObservation(value).measurements.requests = 0.5;
    expect(() => readManifest(value)).toThrow("manifest");
  });

  it("validates evidence independently of JSON property order and detects tampered metrics", () => {
    const evidence = buildReviewedEvidence(readManifest(manifest()));
    expect(validReviewedEvidence(Object.fromEntries(Object.entries(evidence).reverse()))).toBe(
      true,
    );
    nth(evidence.results, 0).metrics.recall = 0;
    expect(validReviewedEvidence(evidence)).toBe(false);
  });
  it("detects the checked-in control's normalization regression while data/provider/presentation stay unchanged", () => {
    const load = (name: string) =>
      buildReviewedEvidence(
        readManifest(
          JSON.parse(
            readFileSync(new URL(`./examples/control-${name}.json`, import.meta.url), "utf8"),
          ),
        ),
      );
    const before = load("before"),
      after = load("after");
    const result = compareReviewedEvidence(before, after);
    expect(result.regressions).toEqual(["business/rewe-invalidenstrasse/normalization"]);
    expect(result.changedProviderInputs).toEqual([]);
    expect(result.changes.filter((entry) => entry.layer !== "normalization")).toEqual([]);
  });
  it("rejects array-valued enums instead of coercing them into trusted capture conditions", () => {
    for (const key of ["kind", "cache"] as const) {
      const value = manifest();
      expect(() =>
        readManifest({
          ...value,
          observations: [{ ...firstObservation(value), [key]: [firstObservation(value)[key]] }],
        }),
      ).toThrow("manifest");
    }
    expect(() =>
      readManifest({
        ...manifest(),
        context: { ...context, configuration: { ...context.configuration, theme: ["dark"] } },
      }),
    ).toThrow("manifest");
  });

  it("records query order/cache isolation and refuses unlike processing stages as a numerical comparison", () => {
    const before = buildReviewedEvidence(readManifest(manifest()));
    const value = manifest();
    firstObservation(value).layer = "normalization";
    firstObservation(value).stage = "adapted-api";
    const first = buildReviewedEvidence(readManifest(value));
    firstObservation(value).stage = "client-ranking";
    const next = buildReviewedEvidence(readManifest(value));
    expect(compareReviewedEvidence(first, next).captureConditionsChanged).toBe(true);
    expect(compareReviewedEvidence(first, next).changes).toEqual([]);
    expect(compareReviewedEvidence(first, next).regressions).toContain(
      "business/rewe-invalidenstrasse/normalization",
    );
    expect(before.manifest?.context.queryOrder).toEqual(["business/rewe-invalidenstrasse"]);
    expect(() =>
      readManifest({
        ...manifest(),
        context: { ...context, cacheIsolation: "shared" },
        observations: [{ ...firstObservation(manifest()), cache: "cold" }],
      }),
    ).toThrow("manifest");
  });

  it("treats lost previously measured performance evidence as a regression", () => {
    const before = buildReviewedEvidence(readManifest(manifest()));
    const value = manifest();
    firstObservation(value).measurements.requests = null;
    firstObservation(value).measurements.latencyMs = null;
    const after = buildReviewedEvidence(readManifest(value));
    expect(after.results[0]?.status).toBe("passed");
    expect(compareReviewedEvidence(before, after).regressions).toContain(
      "business/rewe-invalidenstrasse/provider",
    );
  });
});
