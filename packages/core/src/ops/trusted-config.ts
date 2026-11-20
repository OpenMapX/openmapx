import { createHash } from "node:crypto";
import z from "zod/v4";
import { platformConfigurationSchema } from "../services/platform-configuration";
import { canonicalJson } from "./canonical-json";

export const OPS_TRUSTED_CONFIG_MAX_BYTES = 512 * 1024;
/** How long after preparation a candidate's apply may still be submitted. */
export const CONFIGURATION_CANDIDATE_TTL_MS = 5 * 60_000;
const REVISION_DOMAIN = "openmapx-trusted-config-revision-v1\0";
const JSON_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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
    platform: platformConfigurationSchema.optional(),
    // Opaque encrypted-row identity, never a digest of a credential value.
    transitCredentialsRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    // A new selection, carried by `serviceSelection.apply` only; every other
    // apply renders the operator's selection as it stands.
    selectedRoots: z.array(serviceId).max(256).optional(),
    serviceConfigs: z
      .array(
        z.strictObject({
          serviceId,
          values: configValues,
          // Keys whose value the host env supplies; rendered as a reference, never a value.
          envKeys: z
            .array(configKey)
            .max(128)
            .refine((keys) => new Set(keys).size === keys.length)
            .optional(),
        }),
      )
      .max(256),
    integrationConfigs: z
      .array(z.strictObject({ integrationId: serviceId, values: configValues }))
      .max(256),
    serviceSecrets: z.array(z.strictObject({ serviceId, values: secretValues })).max(256),
  })
  .refine(
    (value) =>
      value.selectedRoots === undefined ||
      new Set(value.selectedRoots).size === value.selectedRoots.length,
  )
  .refine((value) => uniqueBy(value.serviceConfigs, (entry) => entry.serviceId))
  .refine((value) => uniqueBy(value.integrationConfigs, (entry) => entry.integrationId))
  .refine((value) => uniqueBy(value.serviceSecrets, (entry) => entry.serviceId));
export type TrustedConfigurationPayload = z.infer<typeof trustedConfigurationPayloadSchema>;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** The digest an apply operation carries in place of its payload. */
export function configurationPayloadDigest(payload: TrustedConfigurationPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Validates a payload received from another process, including its key and size limits. */
export function parseTrustedConfigurationPayload(value: unknown): TrustedConfigurationPayload {
  if (
    hasUnsafeJsonKeys(value) ||
    Buffer.byteLength(JSON.stringify(value ?? null), "utf8") > OPS_TRUSTED_CONFIG_MAX_BYTES
  )
    throw new Error("Configuration payload rejected");
  return trustedConfigurationPayloadSchema.parse(value);
}

/** What a prepared candidate records about its payload; the payload itself is kept beside it. */
export const configurationSnapshotSchema = z.strictObject({
  version: z.literal(1),
  role: z.enum(["api", "data-manager"]),
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: stableId,
  revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  payloadDigest: digestSchema,
});
export type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;

function snapshotRevision(
  snapshot: Omit<ConfigurationSnapshot, "revisionId" | "payloadDigest">,
  payload: TrustedConfigurationPayload,
): string {
  return `cfg1_${createHash("sha256")
    .update(REVISION_DOMAIN)
    .update(
      canonicalJson({
        version: snapshot.version,
        role: snapshot.role,
        operationKey: snapshot.operationKey,
        issuedAt: snapshot.issuedAt,
        expiresAt: snapshot.expiresAt,
        nonce: snapshot.nonce,
        payload,
      }),
    )
    .digest("base64url")}`;
}

/** Names a new generation after its payload, its operation key and a nonce. */
export function createConfigurationSnapshot(options: {
  role: "api" | "data-manager";
  operationKey: string;
  payload: TrustedConfigurationPayload;
  nonce: string;
  issuedAtMs?: number;
  ttlMs?: number;
}): ConfigurationSnapshot {
  const payload = parseTrustedConfigurationPayload(options.payload);
  const issuedAtMs = options.issuedAtMs ?? Date.now();
  const ttlMs = options.ttlMs ?? CONFIGURATION_CANDIDATE_TTL_MS;
  if (
    !Number.isFinite(issuedAtMs) ||
    !Number.isInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > CONFIGURATION_CANDIDATE_TTL_MS
  )
    throw new Error("Configuration payload rejected");
  const base = {
    version: 1 as const,
    role: options.role,
    operationKey: options.operationKey,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
    nonce: options.nonce,
  };
  return configurationSnapshotSchema.parse({
    ...base,
    revisionId: snapshotRevision(base, payload),
    payloadDigest: configurationPayloadDigest(payload),
  });
}

/** Checks that a snapshot names exactly this payload. */
export function verifyConfigurationSnapshot(
  snapshot: ConfigurationSnapshot,
  payload: TrustedConfigurationPayload,
): { issuedAtMs: number; expiresAtMs: number } {
  const parsed = configurationSnapshotSchema.parse(snapshot);
  const issuedAtMs = Date.parse(parsed.issuedAt);
  const expiresAtMs = Date.parse(parsed.expiresAt);
  if (
    parsed.payloadDigest !== configurationPayloadDigest(payload) ||
    parsed.revisionId !== snapshotRevision(parsed, payload) ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs - issuedAtMs > CONFIGURATION_CANDIDATE_TTL_MS
  )
    throw new Error("Configuration payload rejected");
  return { issuedAtMs, expiresAtMs };
}
