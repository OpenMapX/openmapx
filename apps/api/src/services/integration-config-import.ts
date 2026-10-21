import { isDeepStrictEqual } from "node:util";
import {
  type AdminIntegrationConfigEntry,
  adminIntegrationConfigImportSchema,
} from "@openmapx/core/api-contracts";
import {
  configurationProjectionFingerprint,
  type OpsResultFor,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { getSecretFields, validateConfigBody } from "../utils/validate-config-body";
import { projectIntegrationConfig } from "./integration-config-projection";
import type { TrustedConfigurationApplyOutcome } from "./trusted-config-outcome";

type Schemas = ReadonlyMap<string, Record<string, unknown> | undefined>;
type SavedConfig = { integrationId: string; config: Record<string, unknown> | null };
export class IntegrationImportValidationError extends Error {
  constructor(
    readonly errors: string[] = [
      "Invalid integration import: expected a nonempty batch with unique integration IDs and object configs",
    ],
  ) {
    super("Invalid integration import");
  }
}
function hasMask(value: unknown): boolean {
  return (
    value === "***" ||
    (Array.isArray(value)
      ? value.some(hasMask)
      : value !== null && typeof value === "object" && Object.values(value).some(hasMask))
  );
}
/** One manifest authority for ordinary edits and imports; never echo supplied values. */
export function prepareIntegrationImport(
  body: unknown,
  schemas: Schemas,
): AdminIntegrationConfigEntry[] {
  const parsed = adminIntegrationConfigImportSchema.safeParse(body);
  if (!parsed.success) {
    throw new IntegrationImportValidationError(
      parsed.error.issues.slice(0, 8).map((issue) => {
        const index =
          issue.path[0] === "integrations" && typeof issue.path[1] === "number"
            ? issue.path[1]
            : undefined;
        const entry = index === undefined ? "Import" : `Entry ${index + 1}`;
        const field =
          issue.path[2] === "config" ? (issue.path[3] === "enabled" ? " enabled" : " config") : "";
        return `${entry}${field}: ${issue.code === "custom" && issue.message === "Duplicate integration ID" ? "duplicate integration ID" : "invalid batch, entry or field shape"}`;
      }),
    );
  }
  const errors: string[] = [];
  const entries = parsed.data.integrations.map(({ integrationId, config }, index) => {
    const at = `Entry ${index + 1}`;
    if (!schemas.has(integrationId)) {
      errors.push(`${at}: unknown integration ID`);
      return { integrationId, config };
    }
    // Only catalogue identifiers/field names are eligible for display, never
    // supplied values, unknown keys, or validator messages containing schema data.
    const label = /^[a-z0-9-]{1,64}$/.test(integrationId) ? `${at} (${integrationId})` : at;
    const schema = schemas.get(integrationId);
    const properties = (schema?.properties ?? schema ?? {}) as Record<string, unknown>;
    const secrets = new Set(getSecretFields(schema).map((f) => f.key));
    const { enabled, ...fields } = config;
    const updates: Record<string, unknown> = {};
    for (const [fieldIndex, [key, value]] of Object.entries(fields).entries()) {
      if (secrets.has(key)) continue;
      const known = Object.hasOwn(properties, key) && key !== "type" && key !== "properties";
      const field =
        known && /^[A-Za-z0-9_.-]{1,80}$/.test(key) ? `field "${key}"` : `field #${fieldIndex + 1}`;
      if (!known) {
        errors.push(`${label}: ${field} is not a writable field`);
        continue;
      }
      if (hasMask(value)) {
        errors.push(`${label}: ${field} contains a masked placeholder`);
        continue;
      }
      const checked = validateConfigBody({ [key]: value }, schema);
      if (checked.errors.length) {
        const diagnostic = checked.errors[0];
        const rules: [RegExp, string][] = [
          [/is read-only/, "read-only constraint"],
          [/must be at least|must have at least|must contain at least/, "minimum constraint"],
          [/must be at most|must have at most|must contain at most/, "maximum constraint"],
          [/must be one of:/, "allowed-choice constraint"],
          [/must equal/, "constant constraint"],
          [/is required/, "required-field constraint"],
          [/is not allowed|Unknown config key/, "allowed-field constraint"],
          [/secret field/, "non-secret-field constraint"],
          [/must be (a|an) (boolean|string|number|integer|array|object)$/, "type constraint"],
        ];
        const rule =
          rules.find(([pattern]) => pattern.test(diagnostic))?.[1] ?? "type or value constraints";
        errors.push(`${label}: ${field} violates its ${rule}`);
      } else Object.assign(updates, checked.updates);
    }
    return {
      integrationId,
      config: { ...updates, ...(enabled !== undefined ? { enabled } : {}) },
    } as AdminIntegrationConfigEntry;
  });
  if (errors.length) throw new IntegrationImportValidationError(errors.slice(0, 8));
  return entries;
}
/** Old/unknown DB metadata is deliberately omitted, never guessed to be nonsecret. */
export function exportIntegrationConfigs(rows: SavedConfig[], schemas: Schemas) {
  const integrations: AdminIntegrationConfigEntry[] = [];
  for (const row of rows) {
    if (!schemas.has(row.integrationId)) continue;
    const schema = schemas.get(row.integrationId);
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row.config ?? {})) {
      if (key === "enabled") {
        if (typeof value === "boolean") config.enabled = value;
        continue;
      }
      if (key === "type" || key === "properties" || hasMask(value)) continue;
      const checked = validateConfigBody({ [key]: value }, schema);
      if (!checked.errors.length) Object.assign(config, checked.updates);
    }
    integrations.push({ integrationId: row.integrationId, config } as AdminIntegrationConfigEntry);
  }
  return { integrations, exportedAt: new Date().toISOString(), count: integrations.length };
}

export interface PersistedIntegrationImport {
  previous: SavedConfig[];
  owns(): Promise<boolean>;
  /** Atomic conditional restore of ALL named rows; false means no restoration. */
  restore(): Promise<boolean>;
}
export interface IntegrationImportPorts {
  persist(entries: AdminIntegrationConfigEntry[]): Promise<PersistedIntegrationImport>;
  apply(): Promise<{
    payload?: TrustedConfigurationPayload;
    previousApplied?: OpsResultFor<"configuration.inspect">;
    outcome: TrustedConfigurationApplyOutcome;
  }>;
  compensate(
    payload: TrustedConfigurationPayload,
    expectedRevision: string,
  ): Promise<TrustedConfigurationApplyOutcome>;
  reload(): Promise<{ message: string; reloaded: number; enabled: number }>;
}
const unknownOutcome = (): TrustedConfigurationApplyOutcome => ({
  outcome: "unknown",
  reason: "transport_or_result",
  publisherCleanupFailed: false,
  registryUpdateFailed: false,
});
export function completeConfigurationApply(outcome: TrustedConfigurationApplyOutcome): boolean {
  return (
    outcome.outcome === "committed" &&
    outcome.followUp === "complete" &&
    !outcome.cleanupFailed &&
    !outcome.publisherCleanupFailed &&
    !outcome.registryUpdateFailed
  );
}
/** Only replace this import's integration projection in the ACTUALLY submitted payload.
 * A previously captured full payload would revert unrelated capture-to-apply edits.
 */
function compensationPayload(
  payload: TrustedConfigurationPayload,
  saved: PersistedIntegrationImport,
  entries: AdminIntegrationConfigEntry[],
  schemas: Schemas,
): TrustedConfigurationPayload | undefined {
  const previous = new Map(saved.previous.map((row) => [row.integrationId, row.config]));
  const desired = new Map(entries.map((entry) => [entry.integrationId, entry.config]));
  const result = structuredClone(payload);
  const seen = new Set<string>();
  for (const entry of result.integrationConfigs) {
    const imported = desired.get(entry.integrationId);
    if (!imported) continue;
    seen.add(entry.integrationId);
    const old = previous.get(entry.integrationId) ?? {};
    // Enabled is an ordinary resolved config property only when the manifest declares it.
    const expected = {
      ...imported,
      ...(!Object.hasOwn(imported, "enabled") && Object.hasOwn(old, "enabled")
        ? { enabled: old.enabled }
        : {}),
    };
    if (
      !isDeepStrictEqual(
        entry.values,
        projectIntegrationConfig(schemas.get(entry.integrationId), expected),
      )
    )
      return undefined;
    const previousValues = projectIntegrationConfig(schemas.get(entry.integrationId), old);
    entry.values = previousValues as typeof entry.values;
  }
  return seen.size === entries.length ? result : undefined;
}

/** The observation precedes preparation and its revision fences initial activation.
 * A divergent/absent projection is not recoverable from DB values alone. Fail
 * closed rather than replay saved values as if they were previously applied.
 */
function previousAppliedMatches(
  saved: PersistedIntegrationImport,
  entries: AdminIntegrationConfigEntry[],
  schemas: Schemas,
  observation: OpsResultFor<"configuration.inspect"> | undefined,
): boolean {
  if (!observation?.revisionId) return false;
  const previous = new Map(
    saved.previous.map(({ integrationId, config }) => [integrationId, config]),
  );
  const digests = new Map(
    observation.integrationConfigDigests.map(({ integrationId, digest }) => [
      integrationId,
      digest,
    ]),
  );
  return entries.every(
    ({ integrationId }) =>
      digests.get(integrationId) ===
      configurationProjectionFingerprint(
        projectIntegrationConfig(schemas.get(integrationId), previous.get(integrationId) ?? {}),
      ),
  );
}

/** External effects are not SQL-atomic. Every incomplete path returns explicit evidence. */
export async function runIntegrationImport(
  entries: AdminIntegrationConfigEntry[],
  schemas: Schemas,
  ports: IntegrationImportPorts,
) {
  let saved: PersistedIntegrationImport;
  const failure = {
    ok: false as const,
    error: "Integration import failed",
    recovery: "reconciliation_required" as "reconciliation_required" | "restored",
  };
  try {
    saved = await ports.persist(entries);
  } catch {
    return { ...failure, phase: "persistence" as const, database: "unknown" as const };
  }
  let applied: Awaited<ReturnType<IntegrationImportPorts["apply"]>>;
  try {
    applied = await ports.apply();
  } catch {
    applied = { outcome: unknownOutcome() };
  }
  const apply = applied.outcome;
  let phase: "apply" | "reload" | "ownership" = "apply";
  let runtime: "unchanged" | "unknown" | "restored" = "unchanged";
  if (completeConfigurationApply(apply)) {
    try {
      if (!(await saved.owns()))
        return {
          ...failure,
          phase: "ownership" as const,
          database: "conflict" as const,
          apply,
          runtime,
        };
      phase = "reload";
      runtime = "unknown";
      const reloaded = await ports.reload();
      phase = "ownership";
      if (!(await saved.owns()))
        return { ...failure, phase, database: "conflict" as const, apply, runtime };
      return { ok: true as const, imported: entries.length, skipped: [] as string[], ...reloaded };
    } catch {
      /* qualified DB and host recovery below */
    }
  }
  if (apply.outcome === "unknown")
    return { ...failure, phase, database: "retained" as const, apply, runtime };
  const payload =
    apply.outcome === "committed" && applied.payload
      ? compensationPayload(applied.payload, saved, entries, schemas)
      : undefined;
  if (apply.outcome === "committed" && !payload)
    return {
      ...failure,
      phase,
      database: "retained" as const,
      apply,
      runtime,
      reason: "submitted_snapshot_not_owned" as const,
    };
  if (
    apply.outcome === "committed" &&
    !previousAppliedMatches(saved, entries, schemas, applied.previousApplied)
  ) {
    let database: "retained" | "conflict" | "unknown" = "unknown";
    try {
      database = (await saved.owns()) ? "retained" : "conflict";
    } catch {
      /* Unavailable ownership evidence cannot establish the current saved state. */
    }
    return {
      ...failure,
      phase,
      database,
      apply,
      runtime,
      reason: "previous_applied_not_proven" as const,
    };
  }
  let restored: boolean;
  try {
    restored = await saved.restore();
  } catch {
    return { ...failure, phase, database: "unknown" as const, apply, runtime };
  }
  if (!restored) return { ...failure, phase, database: "conflict" as const, apply, runtime };
  if (apply.outcome === "not_committed")
    return {
      ...failure,
      phase,
      recovery:
        apply.reason === "conflict" ||
        apply.cleanupFailed ||
        apply.publisherCleanupFailed ||
        apply.registryUpdateFailed
          ? ("reconciliation_required" as const)
          : ("restored" as const),
      database: "restored" as const,
      apply,
      runtime,
    };
  // The committed branch above requires an exact owned payload.
  if (!payload) return { ...failure, phase, database: "restored" as const, apply, runtime };
  let compensation: TrustedConfigurationApplyOutcome;
  try {
    compensation = await ports.compensate(payload, apply.revisionId);
  } catch {
    compensation = unknownOutcome();
  }
  if (completeConfigurationApply(compensation) && runtime === "unknown") {
    try {
      await ports.reload();
      runtime = "restored";
    } catch {
      /* runtime remains unknown */
    }
  }
  try {
    if (!(await saved.owns()))
      return { ...failure, phase, database: "conflict" as const, apply, compensation, runtime };
  } catch {
    return { ...failure, phase, database: "unknown" as const, apply, compensation, runtime };
  }
  return {
    ...failure,
    phase,
    database: "restored" as const,
    apply,
    compensation,
    runtime,
    recovery:
      // A fresh publication can repair follow-up/registry state, but cannot prove
      // cleanup of the original publication's artifacts or host writer/claim.
      !apply.cleanupFailed &&
      !apply.publisherCleanupFailed &&
      completeConfigurationApply(compensation) &&
      runtime !== "unknown"
        ? ("restored" as const)
        : ("reconciliation_required" as const),
  };
}
