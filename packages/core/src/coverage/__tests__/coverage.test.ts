import { describe, expect, it } from "vitest";
import {
  assessUsageRights,
  evaluateCapabilityCandidates,
  evaluateFreshness,
  isValidWgs84Bounds,
  relateRegions,
  rightsEvidenceSchema,
  streamEvidenceSchema,
} from "../index";

const now = Date.parse("2026-09-10T12:00:00.000Z");

describe("coverage region semantics", () => {
  it("handles dateline crossing boxes without treating them as invalid", () => {
    const selected = {
      key: "extract:pacific",
      bounds: [170, -10, -170, 10] as const,
    };
    expect(isValidWgs84Bounds(selected.bounds)).toBe(true);
    expect(
      relateRegions(selected, {
        keys: [],
        bounds: [175, -5, -175, 5],
      }).relation,
    ).toBe("intersects");
    expect(
      relateRegions(selected, {
        keys: [],
        bounds: [0, -5, 10, 5],
      }).relation,
    ).toBe("disjoint");
  });

  it("uses geometry for nested extracts with different IDs", () => {
    expect(
      relateRegions(
        { key: "extract:city", bounds: [10, 50, 11, 51] },
        { keys: ["extract:country"], bounds: [5, 47, 16, 55] },
      ).relation,
    ).toBe("contains");
  });

  it("prefers an explicit known region association over geometry", () => {
    expect(
      relateRegions(
        { key: "extract:de", bounds: [5, 47, 16, 55] },
        { keys: ["extract:de"], bounds: [0, 0, 1, 1] },
      ),
    ).toEqual({ relation: "exact", reason: "key" });
  });

  it("does not infer disjointness from different extract IDs", () => {
    expect(relateRegions({ key: "extract:de" }, { keys: ["extract:at"] })).toEqual({
      relation: "unknown",
      reason: "unknown",
    });
    expect(relateRegions({ key: "extract:de" }, { keys: ["country:DE"] }).relation).toBe("unknown");
  });
});

describe("coverage freshness semantics", () => {
  const base = {
    now,
    lastSuccessfulCheckAt: "2026-09-10T11:00:00.000Z",
    lastSuccessfullyCheckedVersion: "v1",
    activeVersion: "v1",
    presence: "present" as const,
    policy: { staleAt: "2026-09-10T13:00:00.000Z", expiresAt: null },
  };

  it("returns each upcoming boundary in order", () => {
    const policy = { staleAt: "2026-09-10T13:00:00.000Z", expiresAt: "2026-09-10T14:00:00.000Z" };
    expect(evaluateFreshness({ ...base, policy }).deadline).toBe(policy.staleAt);
    expect(evaluateFreshness({ ...base, policy, now: Date.parse(policy.staleAt) })).toMatchObject({
      status: "stale",
      deadline: policy.expiresAt,
    });
    expect(evaluateFreshness({ ...base, policy, now: Date.parse(policy.expiresAt) })).toMatchObject(
      { status: "expired", deadline: null },
    );
  });

  it("classifies the exact stale deadline as stale", () => {
    expect(
      evaluateFreshness({
        ...base,
        policy: { staleAt: "2026-09-10T12:00:00.000Z", expiresAt: null },
      }).status,
    ).toBe("stale");
  });

  it("does not turn a failed or unversioned observation into current data", () => {
    expect(
      evaluateFreshness({
        ...base,
        lastSuccessfullyCheckedVersion: null,
      }).status,
    ).toBe("unknown");
    expect(
      evaluateFreshness({
        ...base,
        lastSuccessfulCheckAt: null,
      }).reasons,
    ).toContain("no_publication_evidence");
  });

  it("rejects a future evidence timestamp beyond clock tolerance", () => {
    expect(
      evaluateFreshness({
        ...base,
        lastSuccessfulCheckAt: "2026-09-10T13:00:00.000Z",
      }),
    ).toMatchObject({ status: "unknown", reasons: ["clock_invalid"] });
  });

  it("keeps a successful empty observation valid", () => {
    expect(evaluateFreshness({ ...base, presence: "empty" })).toMatchObject({
      status: "current",
      reasons: ["empty_observation"],
    });
  });
});

describe("coverage capability and rights precedence", () => {
  const candidate = {
    id: "provider-a",
    providerId: "provider-a",
    enabled: true,
    operationSupported: true as const,
    binding: "not-required" as const,
    runtime: "up" as const,
    presence: "present" as const,
    regionRelation: "exact" as const,
    freshness: "current" as const,
    freshnessUsable: true,
    requiredEvidenceKeys: ["evidence-a"],
    reasons: [],
  };

  it("uses operational, limited, unknown, then unavailable precedence", () => {
    expect(
      evaluateCapabilityCandidates({
        operationId: "pois.search",
        domain: "pois",
        candidates: [
          { ...candidate, id: "unavailable", enabled: false },
          { ...candidate, id: "limited", regionRelation: "intersects" },
          { ...candidate, id: "operational" },
        ],
      }).status,
    ).toBe("operational");
    expect(
      evaluateCapabilityCandidates({
        operationId: "pois.search",
        domain: "pois",
        candidates: [{ ...candidate, regionRelation: "intersects" }],
      }).status,
    ).toBe("limited");
    expect(
      evaluateCapabilityCandidates({
        operationId: "pois.search",
        domain: "pois",
        candidates: [{ ...candidate, regionRelation: "unknown" }],
      }).status,
    ).toBe("unknown");
  });

  it("requires observed runtime and never borrows facts from an ineligible alternative", () => {
    const evaluate = (
      candidates: Parameters<typeof evaluateCapabilityCandidates>[0]["candidates"],
    ) => evaluateCapabilityCandidates({ operationId: "pois.search", domain: "pois", candidates });
    expect(evaluate([{ ...candidate, runtime: "unknown" }]).status).toBe("unknown");
    expect(evaluate([{ ...candidate, presence: "unknown", runtime: "down" }]).status).toBe(
      "unavailable",
    );
    expect(evaluate([{ ...candidate, freshness: "stale", freshnessUsable: false }]).status).toBe(
      "unavailable",
    );
    expect(
      evaluate([
        { ...candidate, enabled: false },
        { ...candidate, runtime: "degraded", regionRelation: "intersects" },
      ]),
    ).toMatchObject({
      status: "limited",
      runtime: "degraded",
      geographicQualification: "intersects",
    });
  });

  const rights = (key: string, permission: "yes" | "no" | "conditional" | "unknown") => ({
    key,
    qualifiedDatasetKey: `integration:${key}:dataset`,
    owner: { kind: "integration" as const, id: key },
    sourceId: key,
    commercialUse: permission,
    redistribution: { sourceData: permission, derivedData: permission },
    usageConditions: permission === "conditional" ? ["Keep attribution"] : [],
    lineageKnown: true,
  });

  it("keeps mixed rights conservative and preserves conditions", () => {
    expect(
      assessUsageRights([rights("yes", "yes"), rights("missing", "unknown")], "commercial"),
    ).toMatchObject({ status: "review-required", reasons: ["rights_unknown"] });
    expect(
      assessUsageRights([rights("conditional", "conditional")], "redistribute-source-data"),
    ).toMatchObject({ status: "conditions-apply", conditions: ["Keep attribution"] });
    expect(assessUsageRights([rights("no", "no"), rights("yes", "yes")], "commercial").status).toBe(
      "not-permitted",
    );
  });
});

describe("coverage wire schema", () => {
  it("rejects unbounded/unknown stream fields at the process boundary", () => {
    const result = streamEvidenceSchema.safeParse({
      key: "key",
      owner: { kind: "service", id: "search" },
      sourceId: "osm",
      stream: "search",
      domain: "addresses",
      observedAt: "2026-09-10T12:00:00.000Z",
      evidenceVersion: 1,
      presence: "present",
      region: { keys: [], basis: "unknown", relation: "unknown" },
      publication: { version: null, publishedAt: null, active: null },
      attempt: { at: null, outcome: "unknown" },
      lastSuccessfulCheckAt: null,
      lastSuccessfullyCheckedVersion: null,
      upstreamAsOf: null,
      expiresAt: null,
      policy: { basis: "manual", staleAt: null, version: "1", provenance: "test" },
      freshness: "unknown",
      reasons: [],
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });

  it("accepts only credential-free HTTP(S) rights links", () => {
    const baseRights = {
      key: "rights:owner:source",
      qualifiedDatasetKey: "owner:source",
      owner: { kind: "integration" as const, id: "owner" },
      sourceId: "source",
      commercialUse: "unknown" as const,
      redistribution: { sourceData: "unknown" as const, derivedData: "unknown" as const },
      usageConditions: [],
      lineageKnown: true,
    };
    expect(
      rightsEvidenceSchema.safeParse({
        ...baseRights,
        licenseUrl: "https://example.test/license",
        termsUrl: "http://example.test/terms",
        reviewedAt: "2026-09-10",
      }).success,
    ).toBe(true);
    expect(
      rightsEvidenceSchema.safeParse({
        ...baseRights,
        licenseUrl: "https://example.test/license?token=secret",
      }).success,
    ).toBe(false);
    expect(
      rightsEvidenceSchema.safeParse({ ...baseRights, termsUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
  });
});
