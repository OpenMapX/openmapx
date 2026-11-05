/** Sole closed legacy-import intent issuer. Depends on live writer ownership,
 * strict reads and the existing parser, never the persister/job runner. */
import { canonicalJson, type TrustedConfigurationPayload } from "@openmapx/core/ops";
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
  type ConfigurationCommitParticipant,
  withAdministrativeConfigurationRead,
} from "../administrative-configuration-writer-owner";
import { prepareIntegrationImport } from "../integration-config-import";
import type {
  ProspectiveConfigurationOverlay,
  ValidatedConfigurationCandidate,
} from "../prospective-configuration";

const intentBrand: unique symbol = Symbol("legacy integration import");
export interface LegacyIntegrationImportIntent {
  readonly [intentBrand]: true;
  readonly integrationIds: readonly string[];
  readonly changedIntegrationIds: readonly string[];
}
interface IntentState {
  writer: AdministrativeConfigurationWriter;
  overlay: ProspectiveConfigurationOverlay;
  rows: string;
  registry: string;
  participant: ConfigurationCommitParticipant;
}
const intents = new WeakMap<LegacyIntegrationImportIntent, IntentState>();
const issued = new WeakMap<ConfigurationCommitParticipant, IntentState>();
const refuse = () => new Error("Ordinary integration import unavailable");
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function owned(intent: LegacyIntegrationImportIntent, writer: AdministrativeConfigurationWriter) {
  const state = intents.get(intent);
  if (!state || state.writer !== writer) throw refuse();
  administrativeConfigurationState(writer);
  return state;
}
/** A verifier of this one built-in issuer; it cannot register a foreign implementation. */
export function isLegacyIntegrationImportParticipant(
  participant: ConfigurationCommitParticipant,
  writer: AdministrativeConfigurationWriter,
): boolean {
  return issued.get(participant)?.writer === writer;
}
/** Serialize ONLY provenance issued by this actual built-in constructor. The
 * authenticated private candidate retains it before any desired transaction. */
export function retainedLegacyIntegrationImportIntent(writer: AdministrativeConfigurationWriter) {
  const owner = administrativeConfigurationState(writer),
    participant = owner.participant,
    state = participant && issued.get(participant);
  if (
    !state ||
    state.writer !== writer ||
    state.participant !== participant ||
    participant.mode !== "apply"
  )
    throw refuse();
  const integrationIds = [...writer.integrationIds],
    changedIntegrationIds = state.overlay.changes.map((change) => {
      if (change.kind !== "integration-config" || !integrationIds.includes(change.integrationId))
        throw refuse();
      return change.integrationId;
    });
  if (!changedIntegrationIds.length) throw refuse();
  return freeze({
    version: 1 as const,
    kind: "legacy-integration-config" as const,
    integrationIds,
    changedIntegrationIds,
  });
}

/** Revalidate the actual route body under the complete sorted lock set and strict snapshot. */
export async function prepareLegacyIntegrationImport(
  body: unknown,
  writer: AdministrativeConfigurationWriter,
): Promise<LegacyIntegrationImportIntent> {
  administrativeConfigurationState(writer);
  return withAdministrativeConfigurationRead({}, async (context) => {
    const registry = canonicalJson(
      context.integrations.map((i) => ({ id: i.id, directory: i.directory, manifest: i.manifest })),
    );
    const schemas = new Map(
      context.integrations.map((i) => [
        i.id,
        i.manifest.configSchema as Record<string, unknown> | undefined,
      ]),
    );
    const entries = prepareIntegrationImport(body, schemas).sort((a, b) =>
      a.integrationId.localeCompare(b.integrationId),
    );
    const ids = entries.map((e) => e.integrationId);
    if (canonicalJson(ids) !== canonicalJson(writer.integrationIds)) throw refuse();
    const changes: ProspectiveConfigurationOverlay["changes"] = [];
    for (const entry of entries) {
      const prior = context.integrationRows.filter(
        (row) => row.integrationId === entry.integrationId,
      );
      if (prior.length > 1) throw refuse();
      const old = prior[0]?.config ?? {};
      // This diagnostic checks the old ordinary keys too. An import cannot erase
      // unknown/incompatible legacy fields merely to produce an acceptable seal.
      prepareIntegrationImport(
        { integrations: [{ integrationId: entry.integrationId, config: old }] },
        schemas,
      );
      const properties = (schemas.get(entry.integrationId)?.properties ??
        schemas.get(entry.integrationId) ??
        {}) as Record<string, Record<string, unknown>>;
      const set: Record<string, unknown> = {},
        unset: string[] = [];
      for (const [key, value] of Object.entries(entry.config))
        if (!Object.hasOwn(old, key) || canonicalJson(value) !== canonicalJson(old[key]))
          set[key] = value;
      for (const key of Object.keys(old)) {
        if (key === "enabled" || properties[key]?.["x-openmapx-secret"] === true) continue;
        if (!Object.hasOwn(entry.config, key)) unset.push(key);
      }
      if (Object.keys(set).length || unset.length)
        changes.push({
          kind: "integration-config",
          integrationId: entry.integrationId,
          set: set as TrustedConfigurationPayload["integrationConfigs"][number]["values"],
          unset: unset.sort(),
        });
    }
    const overlay = freeze({
      purpose: "migration" as const,
      coordinatorMode: "ensure-running" as const,
      changes,
    });
    let state: IntentState;
    const assert = async (
      actual: AdministrativeConfigurationWriter,
      candidate?: ValidatedConfigurationCandidate,
    ) => {
      if (
        actual !== writer ||
        issued.get(state.participant) !== state ||
        actual.actorId !== writer.actorId ||
        actual.operationKey !== writer.operationKey
      )
        throw refuse();
      administrativeConfigurationState(actual);
      if (candidate && candidate.operationKey !== actual.operationKey) throw refuse();
      await withAdministrativeConfigurationRead({}, async (read) => {
        if (
          canonicalJson(read.integrationRows) !== state.rows ||
          canonicalJson(
            read.integrations.map((i) => ({
              id: i.id,
              directory: i.directory,
              manifest: i.manifest,
            })),
          ) !== registry
        )
          throw refuse();
      });
    };
    const participant = Object.freeze({
      kind: "configuration-migration",
      mode: "apply",
      actorId: writer.actorId,
      operationKey: writer.operationKey,
      managedServiceSecretKeys: Object.freeze([]),
      authorize: (actual: AdministrativeConfigurationWriter) => assert(actual),
      verify: (
        candidate: ValidatedConfigurationCandidate,
        actual: AdministrativeConfigurationWriter,
      ) => assert(actual, candidate),
      commit: (
        candidate: ValidatedConfigurationCandidate,
        actual: AdministrativeConfigurationWriter,
      ) => assert(actual, candidate),
    }) as unknown as ConfigurationCommitParticipant;
    state = {
      writer,
      overlay,
      rows: canonicalJson(context.integrationRows),
      registry,
      participant,
    };
    const intent = freeze({
      [intentBrand]: true as const,
      integrationIds: ids,
      changedIntegrationIds: changes.map((c) => (c as { integrationId: string }).integrationId),
    });
    intents.set(intent, state);
    issued.set(participant, state);
    return intent;
  });
}

/** Read-only participation from THIS issuer's original opaque intent. No
 * participant registration, callback construction or caller-selected purpose. */
export function legacyIntegrationImportParticipation(
  intent: LegacyIntegrationImportIntent,
  writer: AdministrativeConfigurationWriter,
) {
  const state = owned(intent, writer);
  return Object.freeze({ overlay: state.overlay, participant: state.participant });
}
/** The nominal candidate dispatcher supplies its actual private overlay before
 * preparation and every participant verification/commit. This comparison is
 * read-only; raw overlay data cannot construct an intent or participant. */
export function assertLegacyIntegrationImportOverlay(
  writer: AdministrativeConfigurationWriter,
  overlay: unknown,
): void {
  const owner = administrativeConfigurationState(writer),
    participant = owner.participant,
    state = participant && issued.get(participant);
  if (
    !state ||
    state.writer !== writer ||
    state.participant !== participant ||
    canonicalJson(state.overlay) !== canonicalJson(overlay)
  )
    throw refuse();
}
