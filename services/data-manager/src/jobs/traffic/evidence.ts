import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../../utils/atomic-write.js";
import { scrubSecrets } from "../../utils/scrub-secrets.js";

export type TrafficEvidenceOutcome = "succeeded" | "failed" | "skipped" | "unknown";

export interface TrafficEvidenceStream {
  lastAttemptAt: string | null;
  lastAttemptOutcome: TrafficEvidenceOutcome;
  lastAttemptMessage: string | null;
  lastSuccessfulCheckAt: string | null;
  lastPublishedAt: string | null;
  activeVersion: string | null;
  upstreamAsOf: string | null;
  expiresAt: string | null;
  total: number | null;
  matched: number | null;
  written: number | null;
  outOfBounds: number | null;
  graphApplied: boolean | null;
}

export interface TrafficEvidence {
  version: 1;
  flow: TrafficEvidenceStream;
  conditions: TrafficEvidenceStream;
  graph: TrafficEvidenceStream;
  /** Only populated when graph provenance can be established. */
  graphIdentity: string | null;
  regionKey: string | null;
}

export type TrafficEvidenceLoad =
  | { status: "missing"; evidence: null; error: null }
  | { status: "ok"; evidence: TrafficEvidence; error: null }
  | { status: "corrupt"; evidence: null; error: string };

const writesByPath = new Map<string, Promise<unknown>>();
export const MAX_TRAFFIC_EVIDENCE_BYTES = 256 * 1024;

function emptyStream(): TrafficEvidenceStream {
  return {
    lastAttemptAt: null,
    lastAttemptOutcome: "unknown",
    lastAttemptMessage: null,
    lastSuccessfulCheckAt: null,
    lastPublishedAt: null,
    activeVersion: null,
    upstreamAsOf: null,
    expiresAt: null,
    total: null,
    matched: null,
    written: null,
    outOfBounds: null,
    graphApplied: null,
  };
}

export function defaultTrafficEvidence(): TrafficEvidence {
  return {
    version: 1,
    flow: emptyStream(),
    conditions: emptyStream(),
    graph: emptyStream(),
    graphIdentity: null,
    regionKey: null,
  };
}

export function trafficEvidencePath(statePath: string): string {
  return join(dirname(statePath), "publication-evidence.json");
}

export async function loadTrafficEvidence(path: string): Promise<TrafficEvidenceLoad> {
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_TRAFFIC_EVIDENCE_BYTES) {
      throw new Error("traffic evidence exceeds the bounded file size");
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
      throw new Error("traffic evidence must have version 1");
    }
    const value = parsed as Partial<TrafficEvidence>;
    if (!value.flow || !value.conditions || !value.graph) {
      throw new Error("traffic evidence is missing a stream");
    }
    for (const stream of [value.flow, value.conditions, value.graph]) {
      if (typeof stream !== "object" || Array.isArray(stream))
        throw new Error("invalid traffic stream");
      for (const key of [
        "lastAttemptAt",
        "lastSuccessfulCheckAt",
        "lastPublishedAt",
        "upstreamAsOf",
        "expiresAt",
      ] as const) {
        if (
          stream[key] !== null &&
          stream[key] !== undefined &&
          (typeof stream[key] !== "string" || !Number.isFinite(Date.parse(stream[key])))
        )
          throw new Error("invalid traffic timestamp");
      }
      for (const key of ["total", "matched", "written", "outOfBounds"] as const) {
        if (
          stream[key] !== null &&
          stream[key] !== undefined &&
          (!Number.isSafeInteger(stream[key]) || (stream[key] as number) < 0)
        )
          throw new Error("invalid traffic count");
      }
      for (const key of ["activeVersion", "lastAttemptMessage"] as const) {
        if (
          stream[key] !== null &&
          stream[key] !== undefined &&
          (typeof stream[key] !== "string" || stream[key].length > 2000)
        )
          throw new Error("invalid traffic text");
      }
      if (
        stream.graphApplied !== null &&
        stream.graphApplied !== undefined &&
        typeof stream.graphApplied !== "boolean"
      )
        throw new Error("invalid graph observation");
    }
    const evidence: TrafficEvidence = {
      ...defaultTrafficEvidence(),
      ...value,
      flow: { ...emptyStream(), ...value.flow },
      conditions: { ...emptyStream(), ...value.conditions },
      graph: { ...emptyStream(), ...value.graph },
    };
    if (
      !["succeeded", "failed", "skipped", "unknown"].includes(evidence.flow.lastAttemptOutcome) ||
      !["succeeded", "failed", "skipped", "unknown"].includes(
        evidence.conditions.lastAttemptOutcome,
      ) ||
      !["succeeded", "failed", "skipped", "unknown"].includes(evidence.graph.lastAttemptOutcome)
    ) {
      throw new Error("traffic evidence has invalid attempt outcome");
    }
    return { status: "ok", evidence, error: null };
  } catch (err) {
    const code = err as NodeJS.ErrnoException;
    if (code.code === "ENOENT") return { status: "missing", evidence: null, error: null };
    return {
      status: "corrupt",
      evidence: null,
      error: err instanceof Error ? err.message.slice(0, 500) : "invalid traffic evidence",
    };
  }
}

async function updateTrafficEvidence(
  path: string,
  update: (current: TrafficEvidence) => TrafficEvidence,
): Promise<TrafficEvidence> {
  const previous = writesByPath.get(path) ?? Promise.resolve();
  const write = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await loadTrafficEvidence(path);
      const next = update(current.evidence ?? defaultTrafficEvidence());
      await atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`, {
        durability: "visibility",
        createParentDirectory: true,
        mode: 0o600,
      });
      return next;
    });
  writesByPath.set(path, write);
  try {
    return await write;
  } finally {
    if (writesByPath.get(path) === write) writesByPath.delete(path);
  }
}

function failedStream(
  stream: TrafficEvidenceStream,
  error: unknown,
  at: string,
): TrafficEvidenceStream {
  return {
    ...stream,
    lastAttemptAt: at,
    lastAttemptOutcome: "failed",
    lastAttemptMessage: scrubSecrets(error instanceof Error ? error.message : String(error)).slice(
      0,
      2_000,
    ),
  };
}

export async function recordTrafficFlowSuccess(
  path: string,
  at = new Date().toISOString(),
): Promise<TrafficEvidence> {
  return updateTrafficEvidence(path, (current) => ({
    ...current,
    flow: {
      ...current.flow,
      lastAttemptAt: at,
      lastAttemptOutcome: "succeeded",
      lastAttemptMessage: null,
      lastSuccessfulCheckAt: at,
    },
  }));
}

export async function recordTrafficConditionsSuccess(
  path: string,
  options: { upstreamAsOf?: string | null; expiresAt?: string | null } = {},
  at = new Date().toISOString(),
): Promise<TrafficEvidence> {
  return updateTrafficEvidence(path, (current) => ({
    ...current,
    conditions: {
      ...current.conditions,
      lastAttemptAt: at,
      lastAttemptOutcome: "succeeded",
      lastAttemptMessage: null,
      lastSuccessfulCheckAt: at,
      ...(options.upstreamAsOf !== undefined ? { upstreamAsOf: options.upstreamAsOf } : {}),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    },
  }));
}

export async function recordTrafficGraphSuccess(
  path: string,
  result: {
    total: number;
    matched: number;
    written: number;
    outOfBounds: number;
    overridesUnresolved?: number;
    graphIdentity?: string | null;
    validUntil?: string;
  },
  at = new Date().toISOString(),
): Promise<TrafficEvidence> {
  return updateTrafficEvidence(path, (current) => ({
    ...current,
    graphIdentity:
      result.graphIdentity === undefined ? current.graphIdentity : result.graphIdentity,
    graph: {
      ...current.graph,
      expiresAt: result.validUntil ?? current.graph.expiresAt,
      lastAttemptAt: at,
      lastAttemptOutcome: "succeeded",
      lastAttemptMessage: null,
      lastSuccessfulCheckAt: at,
      lastPublishedAt: at,
      activeVersion: `traffic:${at}`,
      total: result.total,
      matched: result.matched,
      written: result.written,
      outOfBounds: result.outOfBounds,
      graphApplied:
        result.written > 0 && result.outOfBounds === 0 && (result.overridesUnresolved ?? 0) === 0,
    },
  }));
}

export async function recordTrafficFlowFailure(
  path: string,
  error: unknown,
  at = new Date().toISOString(),
): Promise<TrafficEvidence> {
  return updateTrafficEvidence(path, (current) => ({
    ...current,
    flow: failedStream(current.flow, error, at),
  }));
}

export async function recordTrafficConditionsFailure(
  path: string,
  error: unknown,
  at = new Date().toISOString(),
): Promise<TrafficEvidence> {
  return updateTrafficEvidence(path, (current) => ({
    ...current,
    conditions: failedStream(current.conditions, error, at),
  }));
}

export async function recordTrafficGraphFailure(
  path: string,
  error: unknown,
  at = new Date().toISOString(),
): Promise<TrafficEvidence> {
  return updateTrafficEvidence(path, (current) => ({
    ...current,
    graph: failedStream(current.graph, error, at),
  }));
}
