import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import z from "zod/v4";
import { type OpsOperation, type OpsRole, opsOperationSchema } from "./contract";
import { opsOperationFingerprint } from "./fingerprint";

export const OPS_TRUSTED_CONFIG_MAX_BYTES = 512 * 1024;
export const OPS_TRUSTED_CONFIG_TTL_MS = 5 * 60_000;
export const OPS_TRUSTED_CONFIG_QUEUE_MAX_ENTRIES = 128;
export const OPS_TRUSTED_CONFIG_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const OPS_TRUSTED_CONFIG_CLOCK_SKEW_MS = 5_000;
const REJECTED = "Trusted configuration snapshot rejected";
const REVISION_DOMAIN = "openmapx-trusted-config-revision-v1\0";
const MAC_DOMAIN = "openmapx-trusted-config-mac-v1\0";
const JSON_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface TrustedConfigurationQueueUsage {
  retainedEntries: number;
  retainedBytes: number;
  reservedEntries: number;
  reservedBytes: number;
}

/** One budget shared by publication, claim admission, and restart reconciliation. */
export function trustedConfigurationQueueFits(usage: TrustedConfigurationQueueUsage): boolean {
  const values = [
    usage.retainedEntries,
    usage.retainedBytes,
    usage.reservedEntries,
    usage.reservedBytes,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return false;
  return (
    usage.retainedEntries + usage.reservedEntries <= OPS_TRUSTED_CONFIG_QUEUE_MAX_ENTRIES &&
    usage.retainedBytes + usage.reservedBytes <= OPS_TRUSTED_CONFIG_QUEUE_MAX_BYTES
  );
}

const stableId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const serviceId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const configKey = z
  .string()
  .min(1)
  .max(128)
  .regex(JSON_KEY)
  .refine((key) => !key.includes("..") && !FORBIDDEN_JSON_KEYS.has(key));
type BoundedJson =
  | string
  | number
  | boolean
  | null
  | BoundedJson[]
  | { [key: string]: BoundedJson };
const boundedJson: z.ZodType<BoundedJson> = z.lazy(() =>
  z.union([
    z.string().max(8 * 1024),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(boundedJson).max(64),
    z.record(configKey, boundedJson).refine((value) => Object.keys(value).length <= 64),
  ]),
);

function boundedJsonTree(value: unknown, depth = 0): { nodes: number; valid: boolean } {
  if (depth > 6) return { nodes: 0, valid: false };
  if (!value || typeof value !== "object") return { nodes: 1, valid: true };
  if (
    !Array.isArray(value) &&
    Object.keys(value).some(
      (key) => !JSON_KEY.test(key) || key.includes("..") || FORBIDDEN_JSON_KEYS.has(key),
    )
  ) {
    return { nodes: 0, valid: false };
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  let nodes = 1;
  for (const child of children) {
    const result = boundedJsonTree(child, depth + 1);
    nodes += result.nodes;
    if (!result.valid || nodes > 2_048) return { nodes, valid: false };
  }
  return { nodes, valid: true };
}

function hasUnsafeJsonKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!JSON_KEY.test(key) || key.includes("..") || FORBIDDEN_JSON_KEYS.has(key)) return true;
    }
  }
  return Object.values(value).some(hasUnsafeJsonKeys);
}

const configValues = z
  .record(configKey, boundedJson)
  .refine((value) => Object.keys(value).length <= 128 && boundedJsonTree(value).valid);
const secretValues = z
  .record(configKey, z.string().max(64 * 1024))
  .refine((value) => Object.keys(value).length <= 128);
const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$/);

function uniqueBy<T>(values: readonly T[], identity: (value: T) => string): boolean {
  return new Set(values.map(identity)).size === values.length;
}

export const trustedConfigurationPayloadSchema = z
  .strictObject({
    domain,
    selectedRoots: z.array(serviceId).max(256),
    serviceConfigs: z.array(z.strictObject({ serviceId, values: configValues })).max(256),
    integrationConfigs: z
      .array(z.strictObject({ integrationId: serviceId, values: configValues }))
      .max(256),
    serviceSecrets: z.array(z.strictObject({ serviceId, values: secretValues })).max(256),
  })
  .refine((value) => new Set(value.selectedRoots).size === value.selectedRoots.length)
  .refine((value) => uniqueBy(value.serviceConfigs, (entry) => entry.serviceId))
  .refine((value) => uniqueBy(value.integrationConfigs, (entry) => entry.integrationId))
  .refine((value) => uniqueBy(value.serviceSecrets, (entry) => entry.serviceId));
export type TrustedConfigurationPayload = z.infer<typeof trustedConfigurationPayloadSchema>;

const unsignedSchema = z.strictObject({
  version: z.literal(1),
  role: z.enum(["api", "data-manager"]),
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: stableId,
  payload: trustedConfigurationPayloadSchema,
});
const authenticatedSchema = unsignedSchema.extend({
  revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const envelopeSchema = authenticatedSchema.extend({
  mac: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

type UnsignedSnapshot = z.infer<typeof unsignedSchema>;
type AuthenticatedSnapshot = z.infer<typeof authenticatedSchema>;

function reject(): never {
  throw new Error(REJECTED);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validatedToken(token: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) reject();
  const bytes = Buffer.from(token, "base64url");
  if (bytes.byteLength !== 32) reject();
  return bytes;
}

function revisionId(unsigned: UnsignedSnapshot): string {
  return `cfg1_${createHash("sha256")
    .update(REVISION_DOMAIN)
    .update(canonicalJson(unsigned))
    .digest("base64url")}`;
}

function snapshotMac(snapshot: AuthenticatedSnapshot, token: string): string {
  return createHmac("sha256", validatedToken(token))
    .update(MAC_DOMAIN)
    .update(canonicalJson(snapshot))
    .digest("base64url");
}

function revisionFromOperation(operation: OpsOperation): string | undefined {
  return "revisionId" in operation && typeof operation.revisionId === "string"
    ? operation.revisionId
    : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface SealTrustedConfigurationSnapshotOptions {
  role: OpsRole;
  operationKey: string;
  operationForRevision(revisionId: string): OpsOperation;
  payload: TrustedConfigurationPayload;
  token: string;
  issuedAtMs?: number;
  ttlMs?: number;
  nonce: string;
}

export function sealTrustedConfigurationSnapshot(options: SealTrustedConfigurationSnapshotOptions) {
  try {
    if (hasUnsafeJsonKeys(options.payload)) reject();
    const issuedAtMs = options.issuedAtMs ?? Date.now();
    const ttlMs = options.ttlMs ?? OPS_TRUSTED_CONFIG_TTL_MS;
    if (
      !Number.isFinite(issuedAtMs) ||
      !Number.isInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > OPS_TRUSTED_CONFIG_TTL_MS
    ) {
      reject();
    }
    const unsigned = unsignedSchema.parse({
      version: 1,
      role: options.role,
      operationKey: options.operationKey,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
      nonce: options.nonce,
      payload: options.payload,
    });
    const revisionIdValue = revisionId(unsigned);
    const operation = opsOperationSchema.parse(options.operationForRevision(revisionIdValue));
    if (revisionFromOperation(operation) !== revisionIdValue) reject();
    const operationFingerprint = opsOperationFingerprint(operation);
    const authenticated = authenticatedSchema.parse({
      ...unsigned,
      revisionId: revisionIdValue,
      operationFingerprint,
    });
    const bytes = Buffer.from(
      `${JSON.stringify({ ...authenticated, mac: snapshotMac(authenticated, options.token) })}\n`,
      "utf8",
    );
    if (bytes.byteLength > OPS_TRUSTED_CONFIG_MAX_BYTES) reject();
    return { revisionId: revisionIdValue, operation, operationFingerprint, bytes };
  } catch {
    reject();
  }
}

export interface OpenTrustedConfigurationSnapshotOptions {
  role: OpsRole;
  operationKey: string;
  operation: OpsOperation;
  fingerprint: string;
  token: string;
  nowMs?: number;
}

export interface InspectTrustedConfigurationSnapshotOptions {
  token: string;
}

function authenticateTrustedConfigurationSnapshot(
  input: Uint8Array,
  token: string,
): {
  envelope: z.infer<typeof envelopeSchema>;
  issuedAtMs: number;
  expiresAtMs: number;
} {
  if (input.byteLength < 2 || input.byteLength > OPS_TRUSTED_CONFIG_MAX_BYTES) reject();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  const raw = JSON.parse(text) as unknown;
  if (hasUnsafeJsonKeys(raw)) reject();
  const envelope = envelopeSchema.parse(raw);
  const authenticated = authenticatedSchema.parse({
    version: envelope.version,
    role: envelope.role,
    operationKey: envelope.operationKey,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    payload: envelope.payload,
    revisionId: envelope.revisionId,
    operationFingerprint: envelope.operationFingerprint,
  });
  const expectedMac = Buffer.from(snapshotMac(authenticated, token), "base64url");
  const actualMac = Buffer.from(envelope.mac, "base64url");
  const issuedAtMs = Date.parse(envelope.issuedAt);
  const expiresAtMs = Date.parse(envelope.expiresAt);
  if (
    actualMac.byteLength !== expectedMac.byteLength ||
    !timingSafeEqual(actualMac, expectedMac) ||
    envelope.revisionId !==
      revisionId(
        unsignedSchema.parse({
          version: envelope.version,
          role: envelope.role,
          operationKey: envelope.operationKey,
          issuedAt: envelope.issuedAt,
          expiresAt: envelope.expiresAt,
          nonce: envelope.nonce,
          payload: envelope.payload,
        }),
      ) ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > OPS_TRUSTED_CONFIG_TTL_MS
  ) {
    reject();
  }
  return { envelope, issuedAtMs, expiresAtMs };
}

export function inspectTrustedConfigurationSnapshot(
  input: Uint8Array,
  options: InspectTrustedConfigurationSnapshotOptions,
) {
  try {
    const { envelope, issuedAtMs, expiresAtMs } = authenticateTrustedConfigurationSnapshot(
      input,
      options.token,
    );
    return deepFreeze({
      revisionId: envelope.revisionId,
      role: envelope.role,
      operationKey: envelope.operationKey,
      operationFingerprint: envelope.operationFingerprint,
      issuedAtMs,
      expiresAtMs,
    });
  } catch {
    reject();
  }
}

export function openTrustedConfigurationSnapshot(
  input: Uint8Array,
  options: OpenTrustedConfigurationSnapshotOptions,
) {
  try {
    const { envelope, issuedAtMs, expiresAtMs } = authenticateTrustedConfigurationSnapshot(
      input,
      options.token,
    );
    const operation = opsOperationSchema.parse(options.operation);
    const nowMs = options.nowMs ?? Date.now();
    if (
      envelope.role !== options.role ||
      envelope.operationKey !== options.operationKey ||
      revisionFromOperation(operation) !== envelope.revisionId ||
      envelope.operationFingerprint !== options.fingerprint ||
      opsOperationFingerprint(operation) !== envelope.operationFingerprint ||
      issuedAtMs > nowMs + OPS_TRUSTED_CONFIG_CLOCK_SKEW_MS ||
      expiresAtMs <= nowMs ||
      expiresAtMs - issuedAtMs > OPS_TRUSTED_CONFIG_TTL_MS
    ) {
      reject();
    }
    return deepFreeze({ revisionId: envelope.revisionId, payload: envelope.payload });
  } catch {
    reject();
  }
}
