import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { isPrivateEndpoint } from "../provider-config.js";
import { SEMANTIC_DIMENSIONS, SEMANTIC_MODEL } from "../semantic-taxonomy-types.js";

export const DEFAULT_PARSER_BASELINE_MODEL = "gemma3:4b-it-qat";
export const MAX_CONTAINER_LIMIT_BYTES = 8 * 1024 ** 3;
export const MINIMUM_HEADROOM_BYTES = 1024 ** 3;
const MINIMUM_ROUNDS = 5;
const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const EMBEDDING_PROMPT = "Instruct: classify a generic map request\nQuery: a quiet place to read";
const PARSER_PROMPT = "Return a short JSON object for a generic map search for a library.";

export interface SemanticResidencyEvidenceV1 {
  version: 1;
  capturedAt: string;
  referenceLabel: string;
  endpoint: string;
  containerId: string;
  containerLimitBytes: number;
  peakWorkingSetBytes: number;
  headroomBytes: number;
  samples: number;
  activeConcurrentSamples: number;
  concurrentInferenceRounds: number;
  residentModels: Array<{ name: string; digest: string; sizeBytes: number }>;
  evidenceChecksum: string;
}

export interface SemanticResidentModel {
  name: string;
  digest: string;
  sizeBytes: number;
}

export interface SemanticResidencyRuntime {
  inspectContainerLimitBytes(containerId: string): Promise<number>;
  startStats(
    containerId: string,
    onSample: (bytes: number, capturedAtMs: number) => void,
  ): { stop(): Promise<void> };
  listResidentModels(endpoint: string): Promise<SemanticResidentModel[]>;
  runEmbedding(endpoint: string): Promise<void>;
  runParser(endpoint: string): Promise<void>;
  now(): Date;
}

interface ResidencyExpected {
  endpoint: string;
  referenceLabel: string;
  qwenDigest: string;
  parserModel?: string;
  now?: Date;
}

function stableEvidence(evidence: Omit<SemanticResidencyEvidenceV1, "evidenceChecksum">): string {
  return JSON.stringify({
    version: evidence.version,
    capturedAt: evidence.capturedAt,
    referenceLabel: evidence.referenceLabel,
    endpoint: evidence.endpoint,
    containerId: evidence.containerId,
    containerLimitBytes: evidence.containerLimitBytes,
    peakWorkingSetBytes: evidence.peakWorkingSetBytes,
    headroomBytes: evidence.headroomBytes,
    samples: evidence.samples,
    activeConcurrentSamples: evidence.activeConcurrentSamples,
    concurrentInferenceRounds: evidence.concurrentInferenceRounds,
    residentModels: [...evidence.residentModels].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  });
}

export function computeResidencyEvidenceChecksum(
  evidence: Omit<SemanticResidencyEvidenceV1, "evidenceChecksum">,
): string {
  return createHash("sha256").update(stableEvidence(evidence)).digest("hex");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function validateSemanticResidencyEvidence(
  value: unknown,
  expected: ResidencyExpected,
): SemanticResidencyEvidenceV1 {
  const evidence = object(value) as Partial<SemanticResidencyEvidenceV1> | undefined;
  if (evidence?.version !== 1) throw new Error("Residency schema version mismatch");
  if (evidence.endpoint !== expected.endpoint) throw new Error("Residency endpoint mismatch");
  if (evidence.referenceLabel !== expected.referenceLabel) {
    throw new Error("Residency reference label mismatch");
  }
  const capturedAt = new Date(evidence.capturedAt ?? "");
  const now = expected.now ?? new Date();
  const age = now.getTime() - capturedAt.getTime();
  if (!Number.isFinite(capturedAt.getTime()) || age < -5 * 60_000 || age > EVIDENCE_MAX_AGE_MS) {
    throw new Error("Residency evidence is stale");
  }
  const integerFields = [
    evidence.containerLimitBytes,
    evidence.peakWorkingSetBytes,
    evidence.headroomBytes,
    evidence.samples,
    evidence.activeConcurrentSamples,
    evidence.concurrentInferenceRounds,
  ];
  if (integerFields.some((field) => !Number.isSafeInteger(field) || (field ?? -1) < 0)) {
    throw new Error("Residency numeric evidence is invalid");
  }
  if (
    (evidence.containerLimitBytes ?? 0) === 0 ||
    (evidence.containerLimitBytes ?? 0) > MAX_CONTAINER_LIMIT_BYTES
  ) {
    throw new Error("Residency container limit exceeds 8 GiB");
  }
  if ((evidence.headroomBytes ?? 0) < MINIMUM_HEADROOM_BYTES) {
    throw new Error("Residency headroom is below 1 GiB");
  }
  if (
    (evidence.concurrentInferenceRounds ?? 0) < MINIMUM_ROUNDS ||
    (evidence.activeConcurrentSamples ?? 0) < (evidence.concurrentInferenceRounds ?? MINIMUM_ROUNDS)
  ) {
    throw new Error("Residency concurrency evidence is incomplete");
  }
  if (
    (evidence.activeConcurrentSamples ?? 0) > (evidence.samples ?? 0) ||
    (evidence.peakWorkingSetBytes ?? 0) + (evidence.headroomBytes ?? 0) !==
      evidence.containerLimitBytes
  ) {
    throw new Error("Residency byte or sample arithmetic is inconsistent");
  }
  if (!Array.isArray(evidence.residentModels)) throw new Error("Resident model list is missing");
  const models = evidence.residentModels.map((item) => object(item)).filter(Boolean);
  const qwen = models.find((model) => model?.name === SEMANTIC_MODEL);
  const parser = models.find(
    (model) => model?.name === (expected.parserModel ?? DEFAULT_PARSER_BASELINE_MODEL),
  );
  if (qwen?.digest !== expected.qwenDigest || !parser) {
    throw new Error("Residency model identity mismatch");
  }
  for (const model of models) {
    if (
      typeof model?.name !== "string" ||
      typeof model.digest !== "string" ||
      (!Number.isSafeInteger(model.size) && !Number.isSafeInteger(model.sizeBytes)) ||
      ((model.size as number | undefined) ?? (model.sizeBytes as number | undefined) ?? 0) <= 0
    ) {
      throw new Error("Resident model entry is malformed");
    }
  }
  const { evidenceChecksum: _, ...withoutChecksum } = evidence as SemanticResidencyEvidenceV1;
  if (
    typeof evidence.evidenceChecksum !== "string" ||
    evidence.evidenceChecksum !== computeResidencyEvidenceChecksum(withoutChecksum)
  ) {
    throw new Error("Residency evidence checksum mismatch");
  }
  return evidence as SemanticResidencyEvidenceV1;
}

export function parseDockerStatsMemory(input: string): number {
  const used = input.split("/")[0] ?? "";
  const match = used.trim().match(/^([0-9.]+)\s*(B|KiB|MiB|GiB|TiB)/i);
  if (!match) throw new Error("Docker stats memory sample is malformed");
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "tib"
      ? 1024 ** 4
      : unit === "gib"
        ? 1024 ** 3
        : unit === "mib"
          ? 1024 ** 2
          : unit === "kib"
            ? 1024
            : 1;
  const bytes = Math.round(value * multiplier);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Docker stats memory is invalid");
  return bytes;
}

async function jsonRequest(endpoint: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${endpoint}${path}`, init);
  if (!response.ok) throw new Error(`Ollama request failed with HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

function residentModels(
  value: unknown,
): Array<{ name: string; digest: string; sizeBytes: number }> {
  const models = object(value)?.models;
  if (!Array.isArray(models)) throw new Error("Ollama process response is malformed");
  return models.map((entry) => {
    const model = object(entry);
    const name = model?.name;
    const digest = model?.digest;
    const size = model?.size;
    if (typeof name !== "string" || typeof digest !== "string" || !Number.isSafeInteger(size)) {
      throw new Error("Ollama resident model entry is malformed");
    }
    return { name, digest, sizeBytes: size as number };
  });
}

function createSystemResidencyRuntime(): SemanticResidencyRuntime {
  return {
    async inspectContainerLimitBytes(containerId) {
      const inspect = await promisify(execFile)("docker", [
        "inspect",
        containerId,
        "--format",
        "{{.HostConfig.Memory}}",
      ]);
      return Number(inspect.stdout.trim());
    },
    startStats(containerId, onSample) {
      const stats: ChildProcessWithoutNullStreams = spawn(
        "docker",
        ["stats", "--format", "{{.MemUsage}}", containerId],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let buffer = "";
      let stopping = false;
      let closed = false;
      let failure: Error | undefined;
      let finishClose: (() => void) | undefined;
      const close = new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      stats.stdout.setEncoding("utf8");
      stats.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            onSample(parseDockerStatsMemory(line), Date.now());
          } catch (error) {
            failure = error instanceof Error ? error : new Error("Docker stats parsing failed");
          }
        }
      });
      stats.stderr.setEncoding("utf8");
      stats.stderr.on("data", () => undefined);
      stats.once("error", (error) => {
        failure = error;
        closed = true;
        finishClose?.();
      });
      stats.once("close", (code, signal) => {
        closed = true;
        if (!stopping) {
          failure = new Error(`Docker stats exited unexpectedly (${code ?? signal ?? "unknown"})`);
        } else if (code !== 0 && signal !== "SIGTERM") {
          failure = new Error(`Docker stats termination failed (${code ?? signal ?? "unknown"})`);
        }
        finishClose?.();
      });
      return {
        async stop() {
          stopping = true;
          if (!closed) stats.kill("SIGTERM");
          await close;
          if (failure) throw failure;
        },
      };
    },
    async listResidentModels(endpoint) {
      return residentModels(await jsonRequest(endpoint, "/api/ps"));
    },
    async runEmbedding(endpoint) {
      const value = object(
        await jsonRequest(endpoint, "/api/embed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: SEMANTIC_MODEL,
            input: [EMBEDDING_PROMPT],
            dimensions: SEMANTIC_DIMENSIONS,
            truncate: false,
            keep_alive: "30m",
          }),
        }),
      );
      const vectors = value?.embeddings;
      if (
        !Array.isArray(vectors) ||
        !Array.isArray(vectors[0]) ||
        vectors[0].length !== SEMANTIC_DIMENSIONS
      ) {
        throw new Error("Embedding workload response is malformed");
      }
    },
    async runParser(endpoint) {
      const value = object(
        await jsonRequest(endpoint, "/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_PARSER_BASELINE_MODEL,
            messages: [{ role: "user", content: PARSER_PROMPT }],
            stream: false,
            keep_alive: "30m",
            options: { temperature: 0, num_predict: 32 },
          }),
        }),
      );
      if (typeof object(value?.message)?.content !== "string") {
        throw new Error("Parser workload response is malformed");
      }
    },
    now: () => new Date(),
  };
}

function requireResidentTargets(models: readonly SemanticResidentModel[]): {
  qwen: SemanticResidentModel;
  parser: SemanticResidentModel;
} {
  const qwen = models.find(({ name }) => name === SEMANTIC_MODEL);
  const parser = models.find(({ name }) => name === DEFAULT_PARSER_BASELINE_MODEL);
  if (!qwen || !parser) throw new Error("Both target models must be resident");
  for (const model of [qwen, parser]) {
    if (!model.digest || !Number.isSafeInteger(model.sizeBytes) || model.sizeBytes <= 0) {
      throw new Error("Resident target model identity is malformed");
    }
  }
  return { qwen, parser };
}

async function runForAtLeast(
  durationMs: number,
  operation: () => Promise<void>,
  setInFlight: (active: boolean) => void,
): Promise<void> {
  const until = Date.now() + durationMs;
  do {
    setInFlight(true);
    try {
      await operation();
    } finally {
      setInFlight(false);
    }
  } while (Date.now() < until);
}

async function waitForFirstSample(samples: readonly unknown[], timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (samples.length === 0) {
    if (Date.now() - started > timeoutMs) throw new Error("Docker stats produced no sample");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function collectSemanticResidencyEvidence(options: {
  endpoint: string;
  containerId: string;
  referenceLabel: string;
  roundDurationMs?: number;
  rounds?: number;
  runtime?: SemanticResidencyRuntime;
}): Promise<SemanticResidencyEvidenceV1> {
  if (!isPrivateEndpoint(options.endpoint)) throw new Error("Residency endpoint must be private");
  if (!/^[a-f0-9]{12,64}$/i.test(options.containerId)) throw new Error("Container id is invalid");
  if (!options.referenceLabel.trim()) throw new Error("Reference label is required");
  const rounds = options.rounds ?? MINIMUM_ROUNDS;
  const duration = options.roundDurationMs ?? 5_000;
  if (!Number.isSafeInteger(rounds) || rounds < MINIMUM_ROUNDS) {
    throw new Error(`Residency requires at least ${MINIMUM_ROUNDS} rounds`);
  }
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error("Residency round duration is invalid");
  }
  const runtime = options.runtime ?? createSystemResidencyRuntime();
  const containerLimitBytes = await runtime.inspectContainerLimitBytes(options.containerId);
  if (!Number.isSafeInteger(containerLimitBytes) || containerLimitBytes <= 0) {
    throw new Error("Container memory limit is missing");
  }
  if (containerLimitBytes > MAX_CONTAINER_LIMIT_BYTES)
    throw new Error("Container limit exceeds 8 GiB");

  const beforeTargets = requireResidentTargets(await runtime.listResidentModels(options.endpoint));

  let parserInFlight = false;
  let embedderInFlight = false;
  const samples: Array<{ bytes: number; capturedAtMs: number }> = [];
  const activeSamples: Array<{ bytes: number; capturedAtMs: number }> = [];
  const stats = runtime.startStats(options.containerId, (bytes, capturedAtMs) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(capturedAtMs)) {
      throw new Error("Docker stats sample is invalid");
    }
    const sample = { bytes, capturedAtMs };
    samples.push(sample);
    if (parserInFlight && embedderInFlight) activeSamples.push(sample);
  });
  let verifiedRounds = 0;
  try {
    await waitForFirstSample(samples);
    for (let round = 0; round < rounds; round++) {
      const before = activeSamples.length;
      await Promise.all([
        runForAtLeast(
          duration,
          () => runtime.runEmbedding(options.endpoint),
          (active) => {
            embedderInFlight = active;
          },
        ),
        runForAtLeast(
          duration,
          () => runtime.runParser(options.endpoint),
          (active) => {
            parserInFlight = active;
          },
        ),
      ]);
      if (activeSamples.length === before)
        throw new Error(`Residency round ${round + 1} had no concurrent sample`);
      verifiedRounds++;
    }
  } finally {
    await stats.stop();
  }
  const models = await runtime.listResidentModels(options.endpoint);
  const afterTargets = requireResidentTargets(models);
  if (
    afterTargets.qwen.digest !== beforeTargets.qwen.digest ||
    afterTargets.parser.digest !== beforeTargets.parser.digest
  ) {
    throw new Error("Resident target model identity changed during measurement");
  }
  const peakWorkingSetBytes = Math.max(...activeSamples.map(({ bytes }) => bytes));
  const headroomBytes = containerLimitBytes - peakWorkingSetBytes;
  if (headroomBytes < MINIMUM_HEADROOM_BYTES) throw new Error("Active headroom is below 1 GiB");
  const base: Omit<SemanticResidencyEvidenceV1, "evidenceChecksum"> = {
    version: 1,
    capturedAt: runtime.now().toISOString(),
    referenceLabel: options.referenceLabel,
    endpoint: options.endpoint,
    containerId: options.containerId,
    containerLimitBytes,
    peakWorkingSetBytes,
    headroomBytes,
    samples: samples.length,
    activeConcurrentSamples: activeSamples.length,
    concurrentInferenceRounds: verifiedRounds,
    residentModels: models,
  };
  return { ...base, evidenceChecksum: computeResidencyEvidenceChecksum(base) };
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  const values = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Invalid residency arguments");
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = args.endpoint ?? "http://127.0.0.1:11434";
  const containerId = args["container-id"];
  const referenceLabel = args["reference-label"];
  const output = args.output;
  if (!containerId || !referenceLabel || !output)
    throw new Error("--container-id, --reference-label, and --output are required");
  const evidence = await collectSemanticResidencyEvidence({
    endpoint,
    containerId,
    referenceLabel,
  });
  await writeAtomic(output, evidence);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `Semantic residency failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 2;
  });
}
