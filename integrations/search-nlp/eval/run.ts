import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createPassthroughCache } from "@openmapx/integration-framework/testing";
import { buildSemanticCategoryCatalog } from "@openmapx/presets";
import { createOllamaEmbeddingClient } from "../ollama-embeddings.js";
import { isPrivateEndpoint } from "../provider-config.js";
import { createAiSdkNlpProvider } from "../providers/ai-sdk.js";
import { keywordProvider } from "../providers/keyword.js";
import { createSemanticCategoryIndex } from "../semantic-category-index.js";
import { planSemanticResolution } from "../semantic-taxonomy-resolver.js";
import {
  EMBEDDING_SCHEMA_VERSION,
  SEMANTIC_BEHAVIOR_CHECKSUM,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MODEL,
  SEMANTIC_RESOLUTION_POLICY_VERSION,
  type SemanticCalibration,
  SemanticEmbeddingError,
} from "../semantic-taxonomy-types.js";
import type { ParseContext, SearchIntent } from "../types.js";
import { GENERATED_DIRECT_SMOKE_CASES, SEMANTIC_TAXONOMY_CASES } from "./corpus.js";
import {
  type EvaluatedCase,
  evaluateWithCalibration,
  hardGateVerdict,
  provisionalGateVerdict,
  type SemanticEvaluationReport,
  selectCalibration,
  withRuntimeEvidence,
} from "./evaluator.js";
import {
  DEFAULT_PARSER_BASELINE_MODEL,
  type SemanticResidencyEvidenceV1,
  validateSemanticResidencyEvidence,
} from "./measure-residency.js";

type Verdict = "PASS" | "PROVISIONAL" | "FAIL";

const EVALUATION_CONTEXT: ParseContext = {
  mapCenter: [6.0839, 50.7753],
  mapBbox: { south: 50.7, west: 5.95, north: 50.85, east: 6.2 },
};

function parseArgs(argv: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  const values = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Invalid evaluator arguments");
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function number(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "not measured";
}

export function renderSemanticEvaluationReport(input: {
  report: SemanticEvaluationReport;
  verdict: Verdict;
  referenceLabel: string;
  parserBaselineModel: string;
  failures: readonly string[];
}): string {
  const { report } = input;
  const bypassRows = Object.entries(report.latency.bypassP95ByStratum)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stratum, p95]) => `| ${stratum} | ${number(p95)} |`)
    .join("\n");
  const authoredStratumRows = Object.entries(report.corpus.authored.byKind)
    .map(([stratum, count]) => `| kind:${stratum} | ${count} |`)
    .concat(
      Object.entries(report.corpus.authored.byCategoryFamily).map(
        ([stratum, count]) => `| category-family:${stratum} | ${count} |`,
      ),
    )
    .join("\n");
  const confusionRows = report.confusionMatrix
    .map(({ expected, predicted, count }) => `| ${expected} | ${predicted} | ${count} |`)
    .join("\n");
  const policyOutcomeRows = Object.entries(report.policyOutcomeCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join("\n");
  const outcomeRows = report.outcomes
    .map(
      (outcome) =>
        `| ${outcome.id} | ${outcome.expected} | ${outcome.topCategoryId} | ${outcome.appliedCategoryId ?? "—"} | ${outcome.policyCorrect ? "yes" : "no"} |`,
    )
    .join("\n");
  const failureRows = input.failures.length
    ? input.failures.map((failure) => `- ${failure}`).join("\n")
    : "- None";
  const residency = report.residency
    ? `- Evidence checksum: \`${report.residency.evidenceChecksum}\`\n- Container limit: ${report.residency.containerLimitBytes} bytes\n- Peak active working set: ${report.residency.peakWorkingSetBytes} bytes\n- Headroom: ${report.residency.headroomBytes} bytes\n- Active concurrent samples: ${report.residency.activeConcurrentSamples}\n- Concurrent rounds: ${report.residency.concurrentInferenceRounds}`
    : "- Not supplied; a quality-only verdict cannot activate the fallback.";
  return `# Semantic Taxonomy Evaluation

- Model: \`${report.calibration.model}\`
- Model digest: \`${report.calibration.modelDigest}\`
- Dimensions: ${report.calibration.dimensions}
- Embedding schema: ${report.calibration.embeddingSchemaVersion}
- Resolution policy: ${report.calibration.resolutionPolicyVersion}
- Behavior checksum: \`${report.calibration.behaviorChecksum}\`
- Catalog checksum: \`${report.calibration.catalogChecksum}\`
- Minimum score: ${report.calibration.minimumScore}
- Minimum margin: ${report.calibration.minimumMargin}
- Parser baseline: \`${input.parserBaselineModel}\`
- Reference: ${input.referenceLabel}

## Corpus counts

| Slice | Count |
| --- | ---: |
| Generated direct-label smoke | ${report.corpus.generatedSmoke.total} |
| Generated smoke English | ${report.corpus.generatedSmoke.byLanguage.en} |
| Generated smoke German | ${report.corpus.generatedSmoke.byLanguage.de} |
| Authored total | ${report.corpus.authored.total} |
| Authored development | ${report.corpus.authored.bySplit.development} |
| Authored held-out | ${report.corpus.authored.bySplit.test} |
| Authored English | ${report.corpus.authored.byLanguage.en} |
| Authored German | ${report.corpus.authored.byLanguage.de} |
| Authored positives | ${report.corpus.authored.byExpectedStatus.category} |
| Authored abstentions | ${report.corpus.authored.byExpectedStatus.abstain} |
| Authored P0 | ${report.corpus.authored.p0} |

### Authored strata

| Stratum | Count |
| --- | ---: |
${authoredStratumRows}

## Quality gates

| Metric | Result |
| --- | ---: |
| Direct-label top-one | ${percent(report.directLabel.rate)} (${report.directLabel.correct}/${report.directLabel.total}) |
| Held-out English top-one | ${percent(report.heldoutTopOne.byLanguage.en.rate)} |
| Held-out German top-one | ${percent(report.heldoutTopOne.byLanguage.de.rate)} |
| Macro category-family accuracy | ${percent(report.macroCategoryFamilyAccuracy)} |
| Macro category-family accuracy, English | ${percent(report.macroCategoryFamilyAccuracyByLanguage.en)} |
| Macro category-family accuracy, German | ${percent(report.macroCategoryFamilyAccuracyByLanguage.de)} |
| Negative activation | ${percent(report.negatives.activationRate)} (${report.negatives.activations}/${report.negatives.total}) |
| P0 false activations | ${report.negatives.p0FalseActivations} |
| Accepted English precision | ${percent(report.acceptedPositive.byLanguage.en.precision)} |
| Accepted German precision | ${percent(report.acceptedPositive.byLanguage.de.precision)} |
| Safe held-out coverage | ${percent(report.safeCoverage.rate)} (${report.safeCoverage.correct}/${report.safeCoverage.total}) |
| Keyword-miss recovery | ${percent(report.keywordRecovery.rate)} (${report.keywordRecovery.correct}/${report.keywordRecovery.total}) |
| Gemma/default-chain plausible coverage | ${percent(report.parserBaseline.coverage.rate)} (${report.parserBaseline.coverage.correct}/${report.parserBaseline.coverage.total}) |
| Gemma-miss incremental recovery | ${percent(report.parserBaseline.incrementalRecovery.rate)} (${report.parserBaseline.incrementalRecovery.correct}/${report.parserBaseline.incrementalRecovery.total}) |
| Gemma parse failures using production keyword fallback | ${report.parserBaseline.failedCases} |
| Gemma plausible intents unchanged | ${report.parserBaseline.plausibleUnchangedCases}/${report.parserBaseline.plausibleCases} |
| Gemma plausible-intent mutations | ${report.parserBaseline.plausibleMutationCount} |
| Warm query-embedding p50 | ${number(report.latency.warmQueryEmbeddingP50Ms)} ms |
| Warm query-embedding p95 | ${number(report.latency.warmQueryEmbeddingP95Ms)} ms |
| Warm query-embedding p99 | ${number(report.latency.warmQueryEmbeddingP99Ms)} ms |
| Worst resolver bypass p95 | ${number(report.latency.worstBypassP95Ms)} ms |

Direct-label miss IDs: ${report.directLabelMissIds.length > 0 ? report.directLabelMissIds.map((id) => `\`${id}\``).join(", ") : "none"}

## Policy outcome and abstention-reason counts

| Outcome/reason | Count |
| --- | ---: |
${policyOutcomeRows}

## Confusion matrix

| Expected | Raw top category | Count |
| --- | --- | ---: |
${confusionRows}

## Resolver bypass latency

| Stratum | p95 ms |
| --- | ---: |
${bypassRows}

## Residency

${residency}

## Failures

${failureRows}

## Held-out outcomes

Only frozen query IDs are included. Query text, parser output, and embeddings are intentionally excluded.

| Query ID | Expected | Raw top category | Applied category | Policy-correct |
| --- | --- | --- | --- | --- |
${outcomeRows}

Verdict: ${input.verdict}
`;
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function plausibleIntent(): SearchIntent {
  const libraries = buildSemanticCategoryCatalog().find(
    ({ categoryId }) => categoryId === "libraries",
  );
  if (!libraries) throw new Error("Libraries category is unavailable");
  return {
    filter: libraries.filter,
    spatial_constraint: { type: "current_view" },
    time_constraint: null,
    sort_by: "relevance",
    unmapped_attributes: [],
    confidence: 0.6,
    explanation: "Library search",
  };
}

function emptyIntent(): SearchIntent {
  return {
    filter: { selectors: [] },
    spatial_constraint: { type: "current_view" },
    time_constraint: null,
    sort_by: "relevance",
    unmapped_attributes: [],
    confidence: 0.2,
    explanation: "No category",
  };
}

export interface SemanticBypassWorkload {
  name: string;
  query: string;
  lang: "en" | "de";
  intent: SearchIntent;
}

export const SEMANTIC_BYPASS_WORKLOADS: readonly SemanticBypassWorkload[] = [
  { name: "shape-empty", query: "", lang: "en", intent: emptyIntent() },
  { name: "shape-overlength", query: "a".repeat(161), lang: "en", intent: emptyIntent() },
  { name: "letter-free", query: "12345", lang: "en", intent: emptyIntent() },
  { name: "url", query: "https://example.com/cafe", lang: "en", intent: emptyIntent() },
  {
    name: "coordinate-address",
    query: "50.7753, 6.0839",
    lang: "en",
    intent: emptyIntent(),
  },
  { name: "uppercase-code", query: "FRA", lang: "en", intent: emptyIntent() },
  { name: "exact-brand", query: "Starbucks", lang: "en", intent: emptyIntent() },
  { name: "english-proper-name", query: "Hotel Adlon", lang: "en", intent: emptyIntent() },
  { name: "german-proper-name", query: "Café Central", lang: "de", intent: emptyIntent() },
  {
    name: "already-plausible",
    query: "library near me",
    lang: "en",
    intent: plausibleIntent(),
  },
];

export function measureSemanticBypassLatency(
  selected: SemanticCalibration,
  options: {
    warmupIterations?: number;
    batches?: number;
    batchSize?: number;
    now?: () => number;
  } = {},
): Record<string, number> {
  const catalog = buildSemanticCategoryCatalog();
  const warmupIterations = options.warmupIterations ?? 1_000;
  const batches = options.batches ?? 100;
  const batchSize = options.batchSize ?? 1_000;
  const now = options.now ?? performance.now.bind(performance);
  if (warmupIterations < 0 || batches < 1 || batchSize < 1) {
    throw new Error("Bypass benchmark dimensions are invalid");
  }
  const result: Record<string, number> = {};
  for (const workload of SEMANTIC_BYPASS_WORKLOADS) {
    for (let index = 0; index < warmupIterations; index++) {
      const decision = planSemanticResolution({
        query: workload.query,
        lang: workload.lang,
        intent: workload.intent,
        calibration: selected,
        catalog,
        shadow: false,
      });
      if (decision.kind !== "decided")
        throw new Error(`Bypass stratum ${workload.name} reached scoring`);
    }
    const batchAverages: number[] = [];
    for (let batch = 0; batch < batches; batch++) {
      const started = now();
      for (let index = 0; index < batchSize; index++) {
        const decision = planSemanticResolution({
          query: workload.query,
          lang: workload.lang,
          intent: workload.intent,
          calibration: selected,
          catalog,
          shadow: false,
        });
        if (decision.kind !== "decided")
          throw new Error(`Bypass stratum ${workload.name} reached scoring`);
      }
      batchAverages.push((now() - started) / batchSize);
    }
    result[workload.name] = percentile95(batchAverages);
  }
  return result;
}

async function installedModels(endpoint: string): Promise<Map<string, string>> {
  const response = await fetch(`${endpoint}/api/tags`);
  if (!response.ok) throw new Error(`Ollama tags HTTP ${response.status}`);
  const value = (await response.json()) as { models?: Array<{ name?: string; digest?: string }> };
  if (!Array.isArray(value.models)) throw new Error("Ollama tags response is malformed");
  return new Map(
    value.models.flatMap((model) =>
      typeof model.name === "string" && typeof model.digest === "string"
        ? [[model.name, model.digest] as const]
        : [],
    ),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = args.endpoint ?? "http://127.0.0.1:11434";
  const parserBaselineModel = args["parser-baseline-model"];
  const referenceLabel = args["reference-label"];
  const calibrationPath = args.calibration ?? "eval/semantic-calibration.generated.json";
  if (!isPrivateEndpoint(endpoint)) throw new Error("--endpoint must be private");
  if (parserBaselineModel !== DEFAULT_PARSER_BASELINE_MODEL) {
    throw new Error(`--parser-baseline-model must be ${DEFAULT_PARSER_BASELINE_MODEL}`);
  }
  if (!referenceLabel?.trim()) throw new Error("--reference-label is required");
  await unlink(calibrationPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });

  const models = await installedModels(endpoint);
  if (!models.has(SEMANTIC_MODEL)) {
    throw new SemanticEmbeddingError(
      "model-not-ready",
      `Pinned model is absent. Prepare it with: curl ${endpoint}/api/pull -d '{"model":"${SEMANTIC_MODEL}","stream":false}'`,
    );
  }
  if (!models.has(parserBaselineModel)) {
    throw new SemanticEmbeddingError(
      "model-not-ready",
      `Mandatory parser baseline ${parserBaselineModel} is absent`,
    );
  }

  const client = createOllamaEmbeddingClient({ endpoint });
  const index = createSemanticCategoryIndex({ client, cache: createPassthroughCache() });
  const signal = AbortSignal.timeout(30 * 60_000);
  const prepared = await index.prepare(signal);
  const corpus = [...SEMANTIC_TAXONOMY_CASES, ...GENERATED_DIRECT_SMOKE_CASES];
  const evaluated: EvaluatedCase[] = [];
  process.stdout.write(`Scoring ${corpus.length} frozen cases with ${SEMANTIC_MODEL}...\n`);
  for (const testCase of corpus) {
    const keywordIntent = await keywordProvider.parseQuery(testCase.query, EVALUATION_CONTEXT);
    const started = performance.now();
    const score = await index.score(testCase.query, signal);
    const latencyMs = performance.now() - started;
    evaluated.push({ testCase, score, keywordIntent, latencyMs });
  }

  const selected = selectCalibration(evaluated, {
    modelDigest: prepared.modelIdentity.digest,
    catalogChecksum: prepared.catalogChecksum,
    dimensions: SEMANTIC_DIMENSIONS,
    embeddingSchemaVersion: EMBEDDING_SCHEMA_VERSION,
    resolutionPolicyVersion: SEMANTIC_RESOLUTION_POLICY_VERSION,
    behaviorChecksum: SEMANTIC_BEHAVIOR_CHECKSUM,
  });
  if (!selected) throw new Error("No calibration pair passes development safety gates");

  process.stdout.write("Running mandatory held-out Gemma parser baseline...\n");
  const ollama = createOpenAICompatible({
    name: "ollama-semantic-evaluator",
    baseURL: `${endpoint.replace(/\/+$/, "")}/v1`,
    supportsStructuredOutputs: true,
  });
  const parser = createAiSdkNlpProvider({
    id: "evaluation-gemma",
    label: "Evaluation Gemma",
    model: ollama(parserBaselineModel),
    timeoutMs: 120_000,
    requiresNetwork: false,
    cloudProcessors: [],
    cacheKey: "evaluation-only",
  });
  let parserCaseNumber = 0;
  const parserCaseTotal = evaluated.filter(
    (item) => item.testCase.split === "test" && item.testCase.strata.kind !== "direct",
  ).length;
  for (const item of evaluated) {
    if (item.testCase.split !== "test" || item.testCase.strata.kind === "direct") continue;
    parserCaseNumber++;
    try {
      item.parserBaselineIntent = await parser.parseQuery(item.testCase.query, EVALUATION_CONTEXT);
    } catch {
      item.parserBaselineIntent = item.keywordIntent;
      item.parserBaselineFailed = true;
    }
    if (parserCaseNumber % 10 === 0 || parserCaseNumber === parserCaseTotal) {
      process.stdout.write(`Gemma baseline ${parserCaseNumber}/${parserCaseTotal}\n`);
    }
  }

  let report = evaluateWithCalibration(evaluated, selected);
  const bypassP95ByStratum = measureSemanticBypassLatency(selected);
  let residency: SemanticResidencyEvidenceV1 | undefined;
  if (args.residency) {
    residency = validateSemanticResidencyEvidence(
      JSON.parse(await readFile(args.residency, "utf8")) as unknown,
      {
        endpoint,
        referenceLabel,
        qwenDigest: prepared.modelIdentity.digest,
        parserModel: parserBaselineModel,
      },
    );
  }
  report = withRuntimeEvidence(report, {
    bypassP95ByStratum,
    ...(residency
      ? {
          residency: {
            valid: true,
            evidenceChecksum: residency.evidenceChecksum,
            containerLimitBytes: residency.containerLimitBytes,
            peakWorkingSetBytes: residency.peakWorkingSetBytes,
            headroomBytes: residency.headroomBytes,
            activeConcurrentSamples: residency.activeConcurrentSamples,
            concurrentInferenceRounds: residency.concurrentInferenceRounds,
          },
        }
      : {}),
  });
  const verdictResult = residency ? hardGateVerdict(report) : provisionalGateVerdict(report);
  const verdict: Verdict = verdictResult.pass ? (residency ? "PASS" : "PROVISIONAL") : "FAIL";
  const defaultOutput = `eval/reports/qwen3-embedding-0.6b-${prepared.modelIdentity.digest.replace(/^sha256:/, "").slice(0, 12)}.md`;
  const output = args.output ?? defaultOutput;
  await atomicWrite(
    output,
    renderSemanticEvaluationReport({
      report,
      verdict,
      referenceLabel,
      parserBaselineModel,
      failures: verdictResult.failures,
    }),
  );
  if (verdict === "PASS") {
    await atomicWrite(calibrationPath, `${JSON.stringify(selected, null, 2)}\n`);
    process.stdout.write(`Semantic evaluation PASS; calibration written to ${calibrationPath}\n`);
    return;
  }
  process.stdout.write(`Semantic evaluation ${verdict}; report written to ${output}\n`);
  process.exitCode = verdict === "PROVISIONAL" ? 3 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `Semantic evaluation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 2;
  });
}
