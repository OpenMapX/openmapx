import { randomBytes } from "node:crypto";

import {
  type AirQualityStationFeature,
  type AirQualityWarningCode,
  airQualityStationFeatureSchema,
} from "@openmapx/air-quality";
import {
  type IntegrationContext,
  type OpaqueCursorCodec,
  OpaqueCursorError,
} from "@openmapx/integration-framework";
import { z } from "zod";

const PURPOSE = "air-quality-stations-v1";
const SCHEMA_REVISION = "air-quality-stations-1";
const SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_SNAPSHOT_BYTES = 8 * 1_024 * 1_024;
const MAX_SNAPSHOT_FEATURES = 2_000;

const cursorPayloadSchema = z
  .object({
    snapshotId: z.string().regex(/^aqss_1_[A-Za-z0-9_-]{32}$/),
    queryHash: z.string().regex(/^aq_q1_[A-Za-z0-9_-]{43}$/),
    schemaRevision: z.literal(SCHEMA_REVISION),
    offset: z.number().int().nonnegative().max(MAX_SNAPSHOT_FEATURES),
  })
  .strict();

const snapshotSchema = z
  .object({
    queryHash: z.string(),
    policyFingerprint: z.string(),
    features: z.array(airQualityStationFeatureSchema).max(MAX_SNAPSHOT_FEATURES),
    diagnostics: z
      .object({
        providersCandidate: z.array(z.string()),
        providersServed: z.array(z.string()),
        providersFailed: z.array(z.object({ providerId: z.string(), code: z.string() }).strict()),
        providersPolicyExcluded: z.array(z.string()),
        truncated: z.boolean(),
        warnings: z.array(z.string()),
        candidateCount: z.number().int().nonnegative(),
        skippedCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export interface StationSnapshot {
  queryHash: string;
  policyFingerprint: string;
  features: AirQualityStationFeature[];
  diagnostics: {
    providersCandidate: string[];
    providersServed: string[];
    providersFailed: Array<{ providerId: string; code: string }>;
    providersPolicyExcluded: string[];
    truncated: boolean;
    warnings: AirQualityWarningCode[];
    candidateCount: number;
    skippedCount: number;
  };
}

export class StationCursorInvalidError extends Error {
  readonly statusCode = 400;
}

export class StationCursorExpiredError extends Error {
  readonly statusCode = 409;
}

function requireRuntime(ctx: IntegrationContext) {
  if (!ctx.upstreamRuntime)
    throw new StationCursorExpiredError("Station snapshot storage is unavailable");
  return ctx.upstreamRuntime;
}

function requireCodec(codec: OpaqueCursorCodec | undefined): OpaqueCursorCodec {
  if (!codec) throw new StationCursorExpiredError("Station cursor signing is unavailable");
  return codec;
}

function snapshotKey(id: string): string {
  return `air-quality:station-snapshot:${id}`;
}

export function policyFingerprint(input: {
  candidates: readonly string[];
  excluded: readonly string[];
}): string {
  return JSON.stringify({
    candidates: [...input.candidates].sort(),
    excluded: [...input.excluded].sort(),
  });
}

export async function createStationSnapshot(
  ctx: IntegrationContext,
  value: StationSnapshot,
): Promise<{ snapshotId: string; snapshot: StationSnapshot }> {
  const runtime = requireRuntime(ctx);
  let features = value.features.slice(0, MAX_SNAPSHOT_FEATURES);
  const initiallyTruncated = value.features.length > MAX_SNAPSHOT_FEATURES;
  const build = (): StationSnapshot => ({
    ...value,
    features,
    diagnostics: {
      ...value.diagnostics,
      truncated:
        value.diagnostics.truncated ||
        initiallyTruncated ||
        features.length < value.features.length,
      warnings:
        initiallyTruncated || features.length < value.features.length
          ? [...new Set([...value.diagnostics.warnings, "quota_truncated" as const])].sort()
          : value.diagnostics.warnings,
    },
  });
  let snapshot = build();
  while (features.length > 0 && Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES) {
    features = features.slice(0, -1);
    snapshot = build();
  }
  const parsed = snapshotSchema.parse(snapshot) as StationSnapshot;
  const snapshotId = `aqss_1_${randomBytes(24).toString("base64url")}`;
  await runtime.write(snapshotKey(snapshotId), parsed, {
    softMs: SNAPSHOT_TTL_MS,
    hardMs: SNAPSHOT_TTL_MS,
    staleIfErrorMs: SNAPSHOT_TTL_MS,
  });
  return { snapshotId, snapshot: parsed };
}

export function encodeStationCursor(
  ctx: IntegrationContext,
  input: { snapshotId: string; queryHash: string; offset: number },
): string {
  return requireCodec(ctx.cursorCodec).encode(
    PURPOSE,
    { ...input, schemaRevision: SCHEMA_REVISION },
    SNAPSHOT_TTL_MS,
  );
}

export async function readStationSnapshot(
  ctx: IntegrationContext,
  token: string,
  queryHash: string,
  disallowedSourceIds: ReadonlySet<string>,
): Promise<{ snapshotId: string; offset: number; snapshot: StationSnapshot }> {
  let raw: unknown;
  try {
    raw = requireCodec(ctx.cursorCodec).decode(token, PURPOSE);
  } catch (error) {
    if (error instanceof OpaqueCursorError && error.code === "CURSOR_EXPIRED")
      throw new StationCursorExpiredError("Station cursor expired");
    throw new StationCursorInvalidError("Station cursor is invalid");
  }
  const payload = cursorPayloadSchema.safeParse(raw);
  if (!payload.success || payload.data.queryHash !== queryHash)
    throw new StationCursorInvalidError("Station cursor does not match this query");
  const cached = await requireRuntime(ctx).read<unknown>(snapshotKey(payload.data.snapshotId));
  if (cached.state === "miss") throw new StationCursorExpiredError("Station snapshot expired");
  const snapshot = snapshotSchema.safeParse(cached.value);
  if (!snapshot.success) throw new StationCursorExpiredError("Station snapshot is unavailable");
  if (snapshot.data.queryHash !== queryHash)
    throw new StationCursorExpiredError("Station snapshot query binding changed");
  if (
    snapshot.data.features.some(({ properties }) =>
      properties.sourceIds.some((sourceId) => disallowedSourceIds.has(sourceId)),
    )
  )
    throw new StationCursorExpiredError("Station snapshot source policy changed");
  return {
    snapshotId: payload.data.snapshotId,
    offset: payload.data.offset,
    snapshot: snapshot.data as StationSnapshot,
  };
}
