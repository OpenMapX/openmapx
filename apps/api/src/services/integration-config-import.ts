import { isDeepStrictEqual } from "node:util";
import {
  type AdminIntegrationConfigEntry,
  adminIntegrationConfigImportSchema,
} from "@openmapx/core/api-contracts";
import type { TrustedConfigurationPayload } from "@openmapx/core/ops";
import { getSecretFields, validateConfigBody } from "../utils/validate-config-body";
import { projectIntegrationConfig } from "./integration-config-projection";
import type { TrustedConfigurationApplyOutcome } from "./trusted-config-outcome";

type Schemas = ReadonlyMap<string, Record<string, unknown> | undefined>;
type SavedConfig = { integrationId: string; config: Record<string, unknown> | null };
export class IntegrationImportValidationError extends Error {
  constructor() {
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
  if (!parsed.success) throw new IntegrationImportValidationError();
  return parsed.data.integrations.map(({ integrationId, config }) => {
    if (!schemas.has(integrationId)) throw new IntegrationImportValidationError();
    const schema = schemas.get(integrationId);
    const secrets = new Set(getSecretFields(schema).map((f) => f.key));
    const { enabled, ...fields } = config;
    const nonSecret = Object.fromEntries(
      Object.entries(fields).filter(([key]) => !secrets.has(key)),
    );
    if (
      hasMask(nonSecret) ||
      Object.hasOwn(nonSecret, "type") ||
      Object.hasOwn(nonSecret, "properties")
    )
      throw new IntegrationImportValidationError();
    const checked = validateConfigBody(nonSecret, schema);
    if (checked.errors.length) throw new IntegrationImportValidationError();
    return {
      integrationId,
      config: { ...checked.updates, ...(enabled !== undefined ? { enabled } : {}) },
    } as AdminIntegrationConfigEntry;
  });
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
    entry.values = projectIntegrationConfig(
      schemas.get(entry.integrationId),
      old,
    ) as typeof entry.values;
  }
  return seen.size === entries.length ? result : undefined;
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
        apply.cleanupFailed || apply.publisherCleanupFailed || apply.registryUpdateFailed
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
