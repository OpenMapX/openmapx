import { CATEGORY_DEFINITIONS, CATEGORY_FILTERS, type SearchIntent } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { GENERATED_DIRECT_SMOKE_CASES, SEMANTIC_TAXONOMY_CASES } from "../eval/corpus.js";
import {
  type EvaluatedCase,
  evaluateWithCalibration,
  hardGateVerdict,
  provisionalGateVerdict,
  selectCalibration,
  withRuntimeEvidence,
} from "../eval/evaluator.js";
import type { SemanticTaxonomyCaseV1 } from "../eval/fixtures/corpus-v1.js";
import {
  computeResidencyEvidenceChecksum,
  type SemanticResidencyEvidenceV1,
  validateSemanticResidencyEvidence,
} from "../eval/measure-residency.js";
import { renderSemanticEvaluationReport } from "../eval/run.js";
import {
  computeSemanticBehaviorChecksum,
  EMBEDDING_SCHEMA_VERSION,
  SEMANTIC_BEHAVIOR_CHECKSUM,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MODEL,
  SEMANTIC_RESOLUTION_POLICY_VERSION,
  type SemanticCalibration,
} from "../semantic-taxonomy-types.js";

describe("semantic taxonomy corpus", () => {
  it("has unique ids and keeps concept families in one split", () => {
    expect(new Set(SEMANTIC_TAXONOMY_CASES.map((item) => item.id)).size).toBe(
      SEMANTIC_TAXONOMY_CASES.length,
    );
    const splitByFamily = new Map<string, string>();
    for (const item of SEMANTIC_TAXONOMY_CASES) {
      const previous = splitByFamily.get(item.strata.conceptFamily);
      expect(previous === undefined || previous === item.split).toBe(true);
      splitByFamily.set(item.strata.conceptFamily, item.split);
      expect(item.evidence.trim().length).toBeGreaterThan(0);
    }
  });

  it("contains the complete frozen positive and negative coverage", () => {
    const positives = SEMANTIC_TAXONOMY_CASES.filter((item) => item.expected.status === "category");
    const negatives = SEMANTIC_TAXONOMY_CASES.filter((item) => item.expected.status === "abstain");
    const expectedIds = CATEGORY_DEFINITIONS.map(({ id }) => id).filter(
      (id) => CATEGORY_FILTERS[id],
    );
    expect(positives.length).toBeGreaterThanOrEqual(208);
    expect(negatives.length).toBeGreaterThanOrEqual(120);
    expect(
      new Set(
        positives.flatMap((item) =>
          item.expected.status === "category" ? item.expected.acceptableCategoryIds : [],
        ),
      ).size,
    ).toBeGreaterThanOrEqual(expectedIds.length);
    for (const id of expectedIds) {
      const cases = positives.filter((item) => item.strata.categoryFamily === id);
      expect(cases.filter((item) => item.lang === "en")).toHaveLength(2);
      expect(cases.filter((item) => item.lang === "de")).toHaveLength(2);
    }
    expect(
      new Set(
        positives.filter((item) => item.split === "test").map((item) => item.strata.categoryFamily),
      ).size,
    ).toBeGreaterThanOrEqual(16);
  });

  it("contains both languages and every required negative family", () => {
    expect(new Set(SEMANTIC_TAXONOMY_CASES.map((item) => item.lang))).toEqual(
      new Set(["en", "de"]),
    );
    const negativeFamilies = new Set(
      SEMANTIC_TAXONOMY_CASES.flatMap((item) =>
        item.expected.status === "abstain" ? [item.expected.reasonFamily] : [],
      ),
    );
    expect(negativeFamilies).toEqual(
      new Set([
        "proper-name",
        "brand",
        "address-code",
        "ambiguous",
        "no-place-type",
        "unsupported-category",
      ]),
    );
    for (const family of negativeFamilies) {
      const cases = SEMANTIC_TAXONOMY_CASES.filter(
        (item) => item.expected.status === "abstain" && item.expected.reasonFamily === family,
      );
      expect(cases.length).toBeGreaterThanOrEqual(20);
      expect(cases.filter((item) => item.split === "test").length).toBeGreaterThanOrEqual(5);
    }
  });

  it("generates exactly two direct smoke cases per supported category", () => {
    expect(GENERATED_DIRECT_SMOKE_CASES).toHaveLength(104);
  });

  it("binds score-affecting behavior into a stable checksum", () => {
    const checksum = computeSemanticBehaviorChecksum();
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(computeSemanticBehaviorChecksum({ dimensions: 128 })).not.toBe(checksum);
    expect(computeSemanticBehaviorChecksum({ embeddingSchemaVersion: 2 })).not.toBe(checksum);
    expect(computeSemanticBehaviorChecksum({ resolutionPolicyVersion: 2 })).not.toBe(checksum);
    expect(computeSemanticBehaviorChecksum({ queryInstruction: "changed" })).not.toBe(checksum);
  });
});

const emptyIntent = (): SearchIntent => ({
  filter: { selectors: [] },
  spatial_constraint: { type: "current_view" },
  time_constraint: null,
  sort_by: "relevance",
  unmapped_attributes: [],
  confidence: 0.2,
  explanation: "No clear category detected",
});

function evaluated(options: {
  id: string;
  query: string;
  lang: "en" | "de";
  split: "development" | "test";
  expected: SemanticTaxonomyCaseV1["expected"];
  top?: string;
  score?: number;
  margin?: number;
  p0?: boolean;
  kind?: SemanticTaxonomyCaseV1["strata"]["kind"];
  keywordIntent?: SearchIntent;
  parserBaselineIntent?: SearchIntent;
}): EvaluatedCase {
  const topScore = options.score ?? 0.9;
  const margin = options.margin ?? 0.2;
  return {
    testCase: {
      id: options.id,
      query: options.query,
      lang: options.lang,
      split: options.split,
      expected: options.expected,
      strata: {
        kind:
          options.kind ?? (options.expected.status === "category" ? "semantic-only" : "negative"),
        categoryFamily:
          options.expected.status === "category"
            ? (options.expected.acceptableCategoryIds[0] ?? "libraries")
            : options.expected.reasonFamily,
        conceptFamily: options.id,
        p0: options.p0 ?? false,
      },
      evidence: "Synthetic evaluator policy case.",
    },
    score: {
      top: { categoryId: options.top ?? "libraries", score: topScore },
      second: { categoryId: "pharmacies", score: topScore - margin },
      margin,
    },
    keywordIntent: options.keywordIntent ?? emptyIntent(),
    parserBaselineIntent: options.parserBaselineIntent ?? emptyIntent(),
    latencyMs: 100,
  };
}

const identity = {
  modelDigest: "digest",
  catalogChecksum: "catalog",
  dimensions: SEMANTIC_DIMENSIONS,
  embeddingSchemaVersion: EMBEDDING_SCHEMA_VERSION,
  resolutionPolicyVersion: SEMANTIC_RESOLUTION_POLICY_VERSION,
  behaviorChecksum: SEMANTIC_BEHAVIOR_CHECKSUM,
};

function fixedCalibration(minimumScore = 0.8, minimumMargin = 0.15): SemanticCalibration {
  return {
    version: 1,
    model: SEMANTIC_MODEL,
    modelDigest: identity.modelDigest,
    dimensions: SEMANTIC_DIMENSIONS,
    embeddingSchemaVersion: EMBEDDING_SCHEMA_VERSION,
    resolutionPolicyVersion: SEMANTIC_RESOLUTION_POLICY_VERSION,
    behaviorChecksum: SEMANTIC_BEHAVIOR_CHECKSUM,
    catalogChecksum: identity.catalogChecksum,
    minimumScore,
    minimumMargin,
    activationConfidence: 0.55,
  };
}

describe("semantic evaluator", () => {
  it("selects thresholds from development only and enforces policy-derived safety", () => {
    const cases = [
      evaluated({
        id: "dev-en",
        query: "somewhere quiet to study",
        lang: "en",
        split: "development",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "dev-de",
        query: "wo kann ich in Ruhe lernen",
        lang: "de",
        split: "development",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "dev-negative",
        query: "somewhere nice",
        lang: "en",
        split: "development",
        expected: { status: "abstain", reasonFamily: "ambiguous" },
        score: 0.8,
        margin: 0.1,
      }),
      evaluated({
        id: "dev-p0",
        query: "Hotel Adlon",
        lang: "de",
        split: "development",
        expected: { status: "abstain", reasonFamily: "proper-name" },
        p0: true,
        score: 1,
        margin: 1,
      }),
      evaluated({
        id: "test-outlier",
        query: "a place to study",
        lang: "en",
        split: "test",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
        score: 0.99,
        margin: 0.99,
      }),
    ];
    const selected = selectCalibration(cases, identity);
    expect(selected).not.toBeNull();
    expect(selected).toMatchObject({ minimumScore: 0.9, minimumMargin: 0.2 });
  });

  it("returns no calibration when a language has no safely accepted positive", () => {
    const selected = selectCalibration(
      [
        evaluated({
          id: "only-en",
          query: "somewhere quiet to study",
          lang: "en",
          split: "development",
          expected: { status: "category", acceptableCategoryIds: ["libraries"] },
        }),
      ],
      identity,
    );
    expect(selected).toBeNull();
  });

  it("reports raw quality, policy precision, coverage, recovery, and guard outcomes separately", () => {
    const direct = GENERATED_DIRECT_SMOKE_CASES.slice(0, 2).map((testCase) =>
      evaluated({
        id: testCase.id,
        query: testCase.query,
        lang: testCase.lang,
        split: testCase.split,
        expected: testCase.expected,
        kind: "direct",
        top:
          testCase.expected.status === "category"
            ? testCase.expected.acceptableCategoryIds[0]
            : "libraries",
      }),
    );
    const cases = [
      ...direct,
      evaluated({
        id: "test-en",
        query: "somewhere quiet to study",
        lang: "en",
        split: "test",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "test-de",
        query: "wo kann ich in Ruhe lernen",
        lang: "de",
        split: "test",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "guarded-positive",
        query: "Cafe Central",
        lang: "en",
        split: "test",
        expected: { status: "category", acceptableCategoryIds: ["cafes"] },
        top: "cafes",
        score: 1,
        margin: 1,
      }),
      evaluated({
        id: "guarded-p0",
        query: "Hotel Adlon",
        lang: "de",
        split: "test",
        expected: { status: "abstain", reasonFamily: "proper-name" },
        top: "hotels",
        score: 1,
        margin: 1,
        p0: true,
      }),
    ];
    const report = evaluateWithCalibration(cases, fixedCalibration());
    expect(report.directLabel).toMatchObject({ total: 2, correct: 2, rate: 1 });
    expect(report.heldoutTopOne.byLanguage.en.rate).toBe(1);
    expect(report.heldoutTopOne.byLanguage.de.rate).toBe(1);
    expect(report.safeCoverage).toMatchObject({ total: 3, correct: 2 });
    expect(report.keywordRecovery).toMatchObject({ total: 3, correct: 2 });
    expect(report.negatives.p0FalseActivations).toBe(0);
    expect(report.outcomes.find(({ id }) => id === "guarded-positive")).toMatchObject({
      applied: false,
      policyCorrect: false,
    });
  });

  it("keeps generated direct cases out of calibration and authored metrics", () => {
    const authored = [
      evaluated({
        id: "dev-en-clean",
        query: "somewhere quiet to study",
        lang: "en",
        split: "development",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "dev-de-clean",
        query: "wo kann ich in Ruhe lernen",
        lang: "de",
        split: "development",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
    ];
    const badDirect = evaluated({
      id: GENERATED_DIRECT_SMOKE_CASES[0]?.id ?? "direct:activities:en",
      query: GENERATED_DIRECT_SMOKE_CASES[0]?.query ?? "Activities",
      lang: "en",
      split: "development",
      expected: { status: "category", acceptableCategoryIds: ["activities"] },
      kind: "direct",
      top: "libraries",
      score: 1,
      margin: 1,
    });
    expect(selectCalibration([...authored, badDirect], identity)).toEqual(
      selectCalibration(authored, identity),
    );
  });

  it("requires every quality gate provisionally and fresh residency for a hard pass", () => {
    const cases = [
      ...GENERATED_DIRECT_SMOKE_CASES.map((testCase) =>
        evaluated({
          id: testCase.id,
          query: testCase.query,
          lang: testCase.lang,
          split: testCase.split,
          expected: testCase.expected,
          kind: "direct",
          top:
            testCase.expected.status === "category"
              ? testCase.expected.acceptableCategoryIds[0]
              : "libraries",
        }),
      ),
      evaluated({
        id: "pass-en",
        query: "somewhere quiet to study",
        lang: "en",
        split: "test",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "pass-de",
        query: "wo kann ich in Ruhe lernen",
        lang: "de",
        split: "test",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "safe-name",
        query: "Hotel Adlon",
        lang: "de",
        split: "test",
        expected: { status: "abstain", reasonFamily: "proper-name" },
        p0: true,
      }),
    ];
    const report = withRuntimeEvidence(evaluateWithCalibration(cases, fixedCalibration()), {
      bypassP95ByStratum: { shape: 0.2, brand: 0.4 },
    });
    expect(provisionalGateVerdict(report)).toEqual({ pass: true, failures: [] });
    expect(hardGateVerdict(report).pass).toBe(false);
    const final = {
      ...report,
      residency: {
        valid: true,
        evidenceChecksum: "a".repeat(64),
        containerLimitBytes: 8 * 1024 ** 3,
        peakWorkingSetBytes: 6 * 1024 ** 3,
        headroomBytes: 2 * 1024 ** 3,
        activeConcurrentSamples: 5,
        concurrentInferenceRounds: 5,
      },
    };
    expect(hardGateVerdict(final)).toEqual({ pass: true, failures: [] });
  });

  it("renders identities, gates and IDs without leaking frozen query text", () => {
    const knownQuery = "somewhere quiet to study";
    const cases = [
      ...GENERATED_DIRECT_SMOKE_CASES.map((testCase) =>
        evaluated({
          id: testCase.id,
          query: testCase.query,
          lang: testCase.lang,
          split: testCase.split,
          expected: testCase.expected,
          kind: "direct",
          top:
            testCase.expected.status === "category"
              ? testCase.expected.acceptableCategoryIds[0]
              : "libraries",
        }),
      ),
      evaluated({
        id: "report-en",
        query: knownQuery,
        lang: "en",
        split: "test",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "report-de",
        query: "wo kann ich in Ruhe lernen",
        lang: "de",
        split: "test",
        expected: { status: "category", acceptableCategoryIds: ["libraries"] },
      }),
      evaluated({
        id: "report-name",
        query: "Hotel Adlon",
        lang: "de",
        split: "test",
        expected: { status: "abstain", reasonFamily: "proper-name" },
        p0: true,
      }),
    ];
    const report = withRuntimeEvidence(evaluateWithCalibration(cases, fixedCalibration()), {
      bypassP95ByStratum: { shape: 0.1 },
    });
    const rendered = renderSemanticEvaluationReport({
      report,
      verdict: "PROVISIONAL",
      referenceLabel: "test machine",
      parserBaselineModel: "gemma3:4b-it-qat",
      failures: [],
    });
    expect(rendered).toContain("Verdict: PROVISIONAL");
    expect(rendered).toContain("report-en");
    expect(rendered).toContain(SEMANTIC_BEHAVIOR_CHECKSUM);
    expect(rendered).not.toContain(knownQuery);
  });

  it("validates fresh same-machine residency identity, bounds, concurrency and checksum", () => {
    const base: Omit<SemanticResidencyEvidenceV1, "evidenceChecksum"> = {
      version: 1,
      capturedAt: "2026-08-30T12:00:00.000Z",
      referenceLabel: "M1 Pro, 16 GB",
      endpoint: "http://127.0.0.1:11434",
      containerId: "a".repeat(64),
      containerLimitBytes: 8 * 1024 ** 3,
      peakWorkingSetBytes: 6 * 1024 ** 3,
      headroomBytes: 2 * 1024 ** 3,
      samples: 30,
      activeConcurrentSamples: 10,
      concurrentInferenceRounds: 5,
      residentModels: [
        { name: SEMANTIC_MODEL, digest: "qwen-digest", sizeBytes: 700_000_000 },
        { name: "gemma3:4b-it-qat", digest: "gemma-digest", sizeBytes: 3_000_000_000 },
      ],
    };
    const evidence = { ...base, evidenceChecksum: computeResidencyEvidenceChecksum(base) };
    const expected = {
      endpoint: base.endpoint,
      referenceLabel: base.referenceLabel,
      qwenDigest: "qwen-digest",
      now: new Date("2026-08-30T13:00:00.000Z"),
    };
    expect(validateSemanticResidencyEvidence(evidence, expected)).toEqual(evidence);
    expect(() =>
      validateSemanticResidencyEvidence({ ...evidence, concurrentInferenceRounds: 4 }, expected),
    ).toThrow();
    expect(() =>
      validateSemanticResidencyEvidence({ ...evidence, headroomBytes: 1 }, expected),
    ).toThrow();
    expect(() =>
      validateSemanticResidencyEvidence({ ...evidence, evidenceChecksum: "bad" }, expected),
    ).toThrow();
    expect(() =>
      validateSemanticResidencyEvidence(evidence, { ...expected, qwenDigest: "wrong" }),
    ).toThrow();
  });
});
