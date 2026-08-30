import { isPlausibleNlSearch } from "@openmapx/integration-framework";
import { buildSemanticCategoryCatalog } from "@openmapx/presets";
import { planSemanticResolution } from "../semantic-taxonomy-resolver.js";
import {
  EMBEDDING_SCHEMA_VERSION,
  SEMANTIC_BEHAVIOR_CHECKSUM,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MODEL,
  SEMANTIC_RESOLUTION_POLICY_VERSION,
  type SemanticCalibration,
  type SemanticScoreResult,
} from "../semantic-taxonomy-types.js";
import type { SearchIntent } from "../types.js";
import { GENERATED_DIRECT_SMOKE_CASES } from "./corpus.js";
import type { SemanticTaxonomyCaseV1 } from "./fixtures/corpus-v1.js";

export interface EvaluatedCase {
  testCase: SemanticTaxonomyCaseV1;
  score: SemanticScoreResult;
  keywordIntent: SearchIntent;
  parserBaselineIntent?: SearchIntent;
  parserBaselineFailed?: boolean;
  latencyMs: number;
}

export interface MetricSlice {
  total: number;
  correct: number;
  rate: number;
}

export interface PrecisionSlice {
  accepted: number;
  correct: number;
  precision: number | null;
}

export interface SemanticCaseOutcome {
  id: string;
  expected: "category" | "abstain";
  topCategoryId: string;
  rawCorrect: boolean;
  applied: boolean;
  appliedCategoryId?: string;
  policyCorrect: boolean;
}

export interface SemanticConfusionCell {
  expected: string;
  predicted: string;
  count: number;
}

export interface SemanticCorpusSummary {
  generatedSmoke: {
    total: number;
    byLanguage: Record<"en" | "de", number>;
  };
  authored: {
    total: number;
    bySplit: Record<"development" | "test", number>;
    byLanguage: Record<"en" | "de", number>;
    byKind: Record<SemanticTaxonomyCaseV1["strata"]["kind"], number>;
    byExpectedStatus: Record<"category" | "abstain", number>;
    p0: number;
    byCategoryFamily: Record<string, number>;
  };
}

export interface SemanticResidencySummary {
  valid: boolean;
  evidenceChecksum: string;
  containerLimitBytes: number;
  peakWorkingSetBytes: number;
  headroomBytes: number;
  activeConcurrentSamples: number;
  concurrentInferenceRounds: number;
}

export interface SemanticEvaluationReport {
  calibration: SemanticCalibration;
  corpus: SemanticCorpusSummary;
  directLabel: MetricSlice;
  directLabelMissIds: readonly string[];
  heldoutTopOne: MetricSlice & { byLanguage: Record<"en" | "de", MetricSlice> };
  macroCategoryFamilyAccuracy: number;
  macroCategoryFamilyAccuracyByLanguage: Record<"en" | "de", number>;
  negatives: {
    total: number;
    activations: number;
    activationRate: number;
    p0FalseActivations: number;
  };
  acceptedPositive: PrecisionSlice & {
    byLanguage: Record<"en" | "de", PrecisionSlice>;
  };
  safeCoverage: MetricSlice;
  keywordRecovery: MetricSlice;
  parserBaseline: {
    available: boolean;
    failedCases: number;
    plausibleCases: number;
    coverage: MetricSlice;
    plausibleUnchangedCases: number;
    plausibleMutationCount: number;
    incrementalRecovery: MetricSlice;
  };
  latency: {
    warmQueryEmbeddingP50Ms: number;
    warmQueryEmbeddingP95Ms: number;
    warmQueryEmbeddingP99Ms: number;
    bypassP95ByStratum: Record<string, number>;
    worstBypassP95Ms: number;
  };
  residency?: SemanticResidencySummary;
  confusionMatrix: readonly SemanticConfusionCell[];
  policyOutcomeCounts: Readonly<Record<string, number>>;
  outcomes: readonly SemanticCaseOutcome[];
}

export interface CalibrationIdentity {
  modelDigest: string;
  catalogChecksum: string;
  dimensions: typeof SEMANTIC_DIMENSIONS;
  embeddingSchemaVersion: typeof EMBEDDING_SCHEMA_VERSION;
  resolutionPolicyVersion: typeof SEMANTIC_RESOLUTION_POLICY_VERSION;
  behaviorChecksum: string;
}

const catalog = buildSemanticCategoryCatalog();

function calibration(identity: CalibrationIdentity, minimumScore: number, minimumMargin: number) {
  return {
    version: 1 as const,
    model: SEMANTIC_MODEL,
    modelDigest: identity.modelDigest,
    dimensions: identity.dimensions,
    embeddingSchemaVersion: identity.embeddingSchemaVersion,
    resolutionPolicyVersion: identity.resolutionPolicyVersion,
    behaviorChecksum: identity.behaviorChecksum,
    catalogChecksum: identity.catalogChecksum,
    minimumScore,
    minimumMargin,
    activationConfidence: 0.55 as const,
  };
}

function acceptable(testCase: SemanticTaxonomyCaseV1, categoryId: string): boolean {
  return (
    testCase.expected.status === "category" &&
    testCase.expected.acceptableCategoryIds.includes(categoryId)
  );
}

function rate(correct: number, total: number): number {
  return total === 0 ? 0 : correct / total;
}

function precision(correct: number, accepted: number): number | null {
  return accepted === 0 ? null : correct / accepted;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? Number.POSITIVE_INFINITY;
}

interface PolicySummary {
  applied: boolean;
  categoryId?: string;
  correct: boolean;
  intent: SearchIntent;
  outcomeKey: string;
}

function applyPolicy(
  item: EvaluatedCase,
  selected: SemanticCalibration,
  intent: SearchIntent,
): PolicySummary {
  const decision = planSemanticResolution({
    query: item.testCase.query,
    lang: item.testCase.lang,
    intent,
    calibration: selected,
    catalog,
    score: item.score,
    shadow: false,
  });
  if (decision.kind !== "decided") {
    throw new Error(`Semantic policy requested another score for ${item.testCase.id}`);
  }
  const categoryId =
    decision.outcome.status === "matched" ? decision.outcome.categoryId : undefined;
  return {
    applied: decision.applied,
    categoryId,
    correct: decision.applied && categoryId !== undefined && acceptable(item.testCase, categoryId),
    intent: decision.intent,
    outcomeKey: decision.outcome.status === "matched" ? "matched" : decision.outcome.reason,
  };
}

interface FastPolicyCase {
  item: EvaluatedCase;
  eligible: boolean;
  wouldApply: boolean;
}

function preflightCalibrationCases(cases: readonly EvaluatedCase[]): readonly FastPolicyCase[] {
  const permissive: SemanticCalibration = {
    version: 1,
    model: SEMANTIC_MODEL,
    modelDigest: "development",
    dimensions: SEMANTIC_DIMENSIONS,
    embeddingSchemaVersion: EMBEDDING_SCHEMA_VERSION,
    resolutionPolicyVersion: SEMANTIC_RESOLUTION_POLICY_VERSION,
    behaviorChecksum: SEMANTIC_BEHAVIOR_CHECKSUM,
    catalogChecksum: "development",
    minimumScore: Number.NEGATIVE_INFINITY,
    minimumMargin: Number.NEGATIVE_INFINITY,
    activationConfidence: 0.55,
  };
  return cases.map((item) => {
    const withoutScore = planSemanticResolution({
      query: item.testCase.query,
      lang: item.testCase.lang,
      intent: item.keywordIntent,
      calibration: permissive,
      catalog,
      shadow: false,
    });
    if (withoutScore.kind === "decided") {
      return { item, eligible: false, wouldApply: false };
    }
    const withScore = applyPolicy(item, permissive, item.keywordIntent);
    return { item, eligible: true, wouldApply: withScore.applied };
  });
}

function developmentCandidatePasses(
  cases: readonly FastPolicyCase[],
  minimumScore: number,
  minimumMargin: number,
): { pass: boolean; coverage: number; macro: number } {
  let p0FalseActivations = 0;
  let negativeTotal = 0;
  let negativeActivations = 0;
  const positive = cases.filter(({ item }) => item.testCase.expected.status === "category");
  const acceptedByLanguage = { en: 0, de: 0 };
  const correctByLanguage = { en: 0, de: 0 };
  const family = new Map<string, { total: number; correct: number }>();
  let correctAccepted = 0;

  for (const prepared of cases) {
    const { item } = prepared;
    const accepted =
      prepared.eligible &&
      prepared.wouldApply &&
      item.score.top.score >= minimumScore &&
      item.score.margin >= minimumMargin;
    const correct = accepted && acceptable(item.testCase, item.score.top.categoryId);
    if (item.testCase.expected.status === "abstain") {
      negativeTotal++;
      if (accepted) {
        negativeActivations++;
        if (item.testCase.strata.p0) p0FalseActivations++;
      }
      continue;
    }
    if (accepted) acceptedByLanguage[item.testCase.lang]++;
    if (correct) {
      correctAccepted++;
      correctByLanguage[item.testCase.lang]++;
    }
    const aggregate = family.get(item.testCase.strata.categoryFamily) ?? { total: 0, correct: 0 };
    aggregate.total++;
    if (correct) aggregate.correct++;
    family.set(item.testCase.strata.categoryFamily, aggregate);
  }

  const safe =
    p0FalseActivations === 0 &&
    rate(negativeActivations, negativeTotal) <= 0.01 &&
    (["en", "de"] as const).every(
      (lang) =>
        acceptedByLanguage[lang] > 0 &&
        (precision(correctByLanguage[lang], acceptedByLanguage[lang]) ?? 0) >= 0.95,
    );
  const macro = rate(
    [...family.values()].reduce((sum, slice) => sum + rate(slice.correct, slice.total), 0),
    family.size,
  );
  return { pass: safe, coverage: rate(correctAccepted, positive.length), macro };
}

export function selectCalibration(
  cases: readonly EvaluatedCase[],
  identity: CalibrationIdentity,
): SemanticCalibration | null {
  const development = cases.filter(
    ({ testCase }) => testCase.split === "development" && testCase.strata.kind !== "direct",
  );
  const prepared = preflightCalibrationCases(development);
  const scoreCandidates = [...new Set([0, 1, ...development.map(({ score }) => score.top.score)])]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const marginCandidates = [...new Set([0, 1, ...development.map(({ score }) => score.margin)])]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  let best:
    | { minimumScore: number; minimumMargin: number; coverage: number; macro: number }
    | undefined;
  for (const minimumScore of scoreCandidates) {
    for (const minimumMargin of marginCandidates) {
      const result = developmentCandidatePasses(prepared, minimumScore, minimumMargin);
      if (!result.pass) continue;
      const candidate = { minimumScore, minimumMargin, ...result };
      if (
        !best ||
        candidate.coverage > best.coverage ||
        (candidate.coverage === best.coverage && candidate.macro > best.macro) ||
        (candidate.coverage === best.coverage &&
          candidate.macro === best.macro &&
          candidate.minimumScore > best.minimumScore) ||
        (candidate.coverage === best.coverage &&
          candidate.macro === best.macro &&
          candidate.minimumScore === best.minimumScore &&
          candidate.minimumMargin > best.minimumMargin)
      ) {
        best = candidate;
      }
    }
  }
  return best ? calibration(identity, best.minimumScore, best.minimumMargin) : null;
}

function metricSlice(items: readonly EvaluatedCase[], predicate: (item: EvaluatedCase) => boolean) {
  const correct = items.filter(predicate).length;
  return { total: items.length, correct, rate: rate(correct, items.length) };
}

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function macroFamilyAccuracy(items: readonly EvaluatedCase[]): number {
  const familySlices = new Map<string, EvaluatedCase[]>();
  for (const item of items) {
    const family = item.testCase.strata.categoryFamily;
    familySlices.set(family, [...(familySlices.get(family) ?? []), item]);
  }
  return rate(
    [...familySlices.values()].reduce(
      (sum, familyItems) =>
        sum +
        metricSlice(familyItems, (item) => acceptable(item.testCase, item.score.top.categoryId))
          .rate,
      0,
    ),
    familySlices.size,
  );
}

function corpusSummary(
  cases: readonly EvaluatedCase[],
  directIds: ReadonlySet<string>,
): SemanticCorpusSummary {
  const generatedSmoke = cases.filter(({ testCase }) => directIds.has(testCase.id));
  const authored = cases.filter(({ testCase }) => !directIds.has(testCase.id));
  const byKind: SemanticCorpusSummary["authored"]["byKind"] = {
    direct: 0,
    paraphrase: 0,
    "semantic-only": 0,
    structured: 0,
    negative: 0,
  };
  for (const { testCase } of authored) byKind[testCase.strata.kind]++;
  const byCategoryFamily = countBy(authored.map(({ testCase }) => testCase.strata.categoryFamily));
  return {
    generatedSmoke: {
      total: generatedSmoke.length,
      byLanguage: {
        en: generatedSmoke.filter(({ testCase }) => testCase.lang === "en").length,
        de: generatedSmoke.filter(({ testCase }) => testCase.lang === "de").length,
      },
    },
    authored: {
      total: authored.length,
      bySplit: {
        development: authored.filter(({ testCase }) => testCase.split === "development").length,
        test: authored.filter(({ testCase }) => testCase.split === "test").length,
      },
      byLanguage: {
        en: authored.filter(({ testCase }) => testCase.lang === "en").length,
        de: authored.filter(({ testCase }) => testCase.lang === "de").length,
      },
      byKind,
      byExpectedStatus: {
        category: authored.filter(({ testCase }) => testCase.expected.status === "category").length,
        abstain: authored.filter(({ testCase }) => testCase.expected.status === "abstain").length,
      },
      p0: authored.filter(({ testCase }) => testCase.strata.p0).length,
      byCategoryFamily,
    },
  };
}

export function evaluateWithCalibration(
  cases: readonly EvaluatedCase[],
  selected: SemanticCalibration,
): SemanticEvaluationReport {
  const directIds = new Set(GENERATED_DIRECT_SMOKE_CASES.map(({ id }) => id));
  const direct = cases.filter(({ testCase }) => directIds.has(testCase.id));
  const heldout = cases.filter(
    ({ testCase }) => testCase.split === "test" && !directIds.has(testCase.id),
  );
  const positives = heldout.filter(({ testCase }) => testCase.expected.status === "category");
  const negatives = heldout.filter(({ testCase }) => testCase.expected.status === "abstain");
  const policy = new Map(
    heldout.map((item) => [item.testCase.id, applyPolicy(item, selected, item.keywordIntent)]),
  );
  const rawCorrect = (item: EvaluatedCase) => acceptable(item.testCase, item.score.top.categoryId);
  const byLanguage = Object.fromEntries(
    (["en", "de"] as const).map((lang) => {
      const items = positives.filter(({ testCase }) => testCase.lang === lang);
      return [lang, metricSlice(items, rawCorrect)];
    }),
  ) as Record<"en" | "de", MetricSlice>;
  const macroCategoryFamilyAccuracy = macroFamilyAccuracy(positives);
  const macroCategoryFamilyAccuracyByLanguage = Object.fromEntries(
    (["en", "de"] as const).map((lang) => [
      lang,
      macroFamilyAccuracy(positives.filter(({ testCase }) => testCase.lang === lang)),
    ]),
  ) as Record<"en" | "de", number>;
  const acceptedSlices = Object.fromEntries(
    (["en", "de"] as const).map((lang) => {
      const items = positives.filter(({ testCase }) => testCase.lang === lang);
      const accepted = items.filter((item) => policy.get(item.testCase.id)?.applied);
      const correct = accepted.filter((item) => policy.get(item.testCase.id)?.correct).length;
      return [
        lang,
        { accepted: accepted.length, correct, precision: precision(correct, accepted.length) },
      ];
    }),
  ) as Record<"en" | "de", PrecisionSlice>;
  const accepted = positives.filter((item) => policy.get(item.testCase.id)?.applied);
  const acceptedCorrect = accepted.filter((item) => policy.get(item.testCase.id)?.correct).length;
  const safelyRecovered = positives.filter((item) => policy.get(item.testCase.id)?.correct);
  const keywordMisses = positives.filter(
    ({ keywordIntent }) => !isPlausibleNlSearch(keywordIntent),
  );
  const keywordRecovered = keywordMisses.filter((item) => policy.get(item.testCase.id)?.correct);
  const p0FalseActivations = negatives.filter(
    (item) => item.testCase.strata.p0 && policy.get(item.testCase.id)?.applied,
  ).length;
  const negativeActivations = negatives.filter(
    (item) => policy.get(item.testCase.id)?.applied,
  ).length;

  const withParser = heldout.filter(
    ({ parserBaselineIntent }) => parserBaselineIntent !== undefined,
  );
  const parserPlausible = withParser.filter(({ parserBaselineIntent }) =>
    isPlausibleNlSearch(parserBaselineIntent as SearchIntent),
  );
  let parserMutationCount = 0;
  for (const item of parserPlausible) {
    const original = item.parserBaselineIntent as SearchIntent;
    const outcome = applyPolicy(item, selected, original);
    if (
      outcome.intent !== original ||
      JSON.stringify(outcome.intent) !== JSON.stringify(original)
    ) {
      parserMutationCount++;
    }
  }
  const parserMisses = withParser.filter(
    ({ testCase, parserBaselineIntent }) =>
      testCase.expected.status === "category" &&
      !isPlausibleNlSearch(parserBaselineIntent as SearchIntent),
  );
  const parserRecovered = parserMisses.filter((item) => {
    const result = applyPolicy(item, selected, item.parserBaselineIntent as SearchIntent);
    return result.correct;
  });

  const confusion = new Map<string, SemanticConfusionCell>();
  for (const item of heldout) {
    const expected =
      item.testCase.expected.status === "category"
        ? item.testCase.expected.acceptableCategoryIds.join("|")
        : `abstain:${item.testCase.expected.reasonFamily}`;
    const predicted = item.score.top.categoryId;
    const key = `${expected}\u0000${predicted}`;
    const cell = confusion.get(key) ?? { expected, predicted, count: 0 };
    cell.count++;
    confusion.set(key, cell);
  }
  const confusionMatrix = [...confusion.values()].sort(
    (left, right) =>
      left.expected.localeCompare(right.expected) || left.predicted.localeCompare(right.predicted),
  );
  const policyOutcomeCounts = countBy(
    heldout.map((item) => (policy.get(item.testCase.id) as PolicySummary).outcomeKey),
  );

  const outcomes = heldout.map((item): SemanticCaseOutcome => {
    const result = policy.get(item.testCase.id) as PolicySummary;
    return {
      id: item.testCase.id,
      expected: item.testCase.expected.status,
      topCategoryId: item.score.top.categoryId,
      rawCorrect: rawCorrect(item),
      applied: result.applied,
      ...(result.categoryId ? { appliedCategoryId: result.categoryId } : {}),
      policyCorrect: item.testCase.expected.status === "abstain" ? !result.applied : result.correct,
    };
  });

  return {
    calibration: selected,
    corpus: corpusSummary(cases, directIds),
    directLabel: metricSlice(direct, rawCorrect),
    directLabelMissIds: direct
      .filter((item) => !rawCorrect(item))
      .map(({ testCase }) => testCase.id),
    heldoutTopOne: { ...metricSlice(positives, rawCorrect), byLanguage },
    macroCategoryFamilyAccuracy,
    macroCategoryFamilyAccuracyByLanguage,
    negatives: {
      total: negatives.length,
      activations: negativeActivations,
      activationRate: rate(negativeActivations, negatives.length),
      p0FalseActivations,
    },
    acceptedPositive: {
      accepted: accepted.length,
      correct: acceptedCorrect,
      precision: precision(acceptedCorrect, accepted.length),
      byLanguage: acceptedSlices,
    },
    safeCoverage: {
      total: positives.length,
      correct: safelyRecovered.length,
      rate: rate(safelyRecovered.length, positives.length),
    },
    keywordRecovery: {
      total: keywordMisses.length,
      correct: keywordRecovered.length,
      rate: rate(keywordRecovered.length, keywordMisses.length),
    },
    parserBaseline: {
      available: withParser.length === heldout.length && heldout.length > 0,
      failedCases: withParser.filter(({ parserBaselineFailed }) => parserBaselineFailed).length,
      plausibleCases: parserPlausible.length,
      coverage: {
        total: withParser.length,
        correct: parserPlausible.length,
        rate: rate(parserPlausible.length, withParser.length),
      },
      plausibleUnchangedCases: parserPlausible.length - parserMutationCount,
      plausibleMutationCount: parserMutationCount,
      incrementalRecovery: {
        total: parserMisses.length,
        correct: parserRecovered.length,
        rate: rate(parserRecovered.length, parserMisses.length),
      },
    },
    latency: {
      warmQueryEmbeddingP50Ms: percentile(
        heldout.map(({ latencyMs }) => latencyMs),
        0.5,
      ),
      warmQueryEmbeddingP95Ms: percentile(
        heldout.map(({ latencyMs }) => latencyMs),
        0.95,
      ),
      warmQueryEmbeddingP99Ms: percentile(
        heldout.map(({ latencyMs }) => latencyMs),
        0.99,
      ),
      bypassP95ByStratum: {},
      worstBypassP95Ms: Number.POSITIVE_INFINITY,
    },
    confusionMatrix,
    policyOutcomeCounts,
    outcomes,
  };
}

export function withRuntimeEvidence(
  report: SemanticEvaluationReport,
  evidence: {
    bypassP95ByStratum: Record<string, number>;
    residency?: SemanticResidencySummary;
  },
): SemanticEvaluationReport {
  const bypassValues = Object.values(evidence.bypassP95ByStratum);
  return {
    ...report,
    latency: {
      ...report.latency,
      bypassP95ByStratum: { ...evidence.bypassP95ByStratum },
      worstBypassP95Ms:
        bypassValues.length > 0 ? Math.max(...bypassValues) : Number.POSITIVE_INFINITY,
    },
    ...(evidence.residency ? { residency: evidence.residency } : {}),
  };
}

function qualityFailures(report: SemanticEvaluationReport): string[] {
  const failures: string[] = [];
  if (report.negatives.p0FalseActivations !== 0) failures.push("P0 false activations must be zero");
  if (report.negatives.activationRate > 0.01) failures.push("negative activation exceeds 1%");
  for (const lang of ["en", "de"] as const) {
    const accepted = report.acceptedPositive.byLanguage[lang];
    if (accepted.accepted === 0 || (accepted.precision ?? 0) < 0.95) {
      failures.push(`${lang} accepted-positive precision is below 95% or empty`);
    }
    if (report.heldoutTopOne.byLanguage[lang].rate < 0.85) {
      failures.push(`${lang} held-out top-one accuracy is below 85%`);
    }
  }
  if (report.directLabel.rate < 1) failures.push("direct-label top-one accuracy is below 100%");
  if (report.macroCategoryFamilyAccuracy < 0.8)
    failures.push("macro category accuracy is below 80%");
  if (report.safeCoverage.rate < 0.6) failures.push("safe coverage is below 60%");
  if (report.keywordRecovery.rate < 0.25) failures.push("keyword recovery is below 25%");
  if (!report.parserBaseline.available) failures.push("mandatory parser baseline is incomplete");
  if (report.parserBaseline.plausibleMutationCount !== 0)
    failures.push("plausible parser intents mutated");
  if (report.latency.warmQueryEmbeddingP95Ms > 500)
    failures.push("warm embedding p95 exceeds 500 ms");
  if (report.latency.worstBypassP95Ms >= 1) failures.push("worst bypass p95 is not below 1 ms");
  return failures;
}

export function provisionalGateVerdict(report: SemanticEvaluationReport): {
  pass: boolean;
  failures: string[];
} {
  const failures = qualityFailures(report);
  return { pass: failures.length === 0, failures };
}

export function hardGateVerdict(report: SemanticEvaluationReport): {
  pass: boolean;
  failures: string[];
} {
  const failures = qualityFailures(report);
  if (!report.residency?.valid) failures.push("fresh validated residency evidence is required");
  return { pass: failures.length === 0, failures };
}
