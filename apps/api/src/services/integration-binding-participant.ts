/** Sole built-in issuer for binding changes in the existing candidate transaction. */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { and, eq, sql } from "drizzle-orm";
import z from "zod/v4";
import {
  adminAuditLog,
  capabilityBinding,
  integrationApplicationReceipt,
  integrationBindingRevision,
} from "../db/schema";
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
  type ConfigurationCommitParticipant,
  type ConfigurationWriteTransaction,
  withAdministrativeConfigurationRead,
} from "./administrative-configuration-writer-owner";
import {
  bindingContentRevision,
  capturedBindingState,
  readBindingState,
} from "./integration-binding-state";
import type {
  ProspectiveConfigurationOverlay,
  ValidatedConfigurationCandidate,
} from "./prospective-configuration";
export const integrationBindingInputSchema = z.strictObject({
  integrationId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  capability: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => !["__proto__", "constructor", "prototype"].includes(value)),
  serviceId: z.string().min(1).max(64).nullable(),
  expectedServiceId: z.string().min(1).max(64).nullable(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type IntegrationBindingInput = z.infer<typeof integrationBindingInputSchema>;
export class IntegrationBindingConflict extends Error {
  constructor(readonly code = "BINDING_VERSION_CONFLICT") {
    super(code);
  }
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const intentBrand: unique symbol = Symbol("integration binding");
export interface IntegrationBindingIntent {
  readonly [intentBrand]: true;
  readonly integrationId: string;
}
interface State {
  writer: AdministrativeConfigurationWriter;
  overlay: ProspectiveConfigurationOverlay;
  participant: ConfigurationCommitParticipant;
  input: IntegrationBindingInput;
  before: ReturnType<typeof capturedBindingState>;
  registry: string;
  committed: boolean;
}
const intents = new WeakMap<IntegrationBindingIntent, State>(),
  issued = new WeakMap<ConfigurationCommitParticipant, State>();
function active(writer: AdministrativeConfigurationWriter) {
  return administrativeConfigurationState(writer);
}
export function isIntegrationBindingParticipant(
  participant: ConfigurationCommitParticipant,
  writer: AdministrativeConfigurationWriter,
) {
  return issued.get(participant)?.writer === writer;
}
export function assertIntegrationBindingOverlay(
  writer: AdministrativeConfigurationWriter,
  overlay: unknown,
) {
  const state = active(writer),
    owned = state.participant && issued.get(state.participant);
  if (!owned || owned.writer !== writer || canonicalJson(owned.overlay) !== canonicalJson(overlay))
    throw Error("Binding participant unavailable");
}
export function integrationBindingParticipation(
  intent: IntegrationBindingIntent,
  writer: AdministrativeConfigurationWriter,
) {
  const state = intents.get(intent);
  if (!state || state.writer !== writer) throw Error("Binding intent unavailable");
  active(writer);
  return { overlay: state.overlay, participant: state.participant };
}
export async function prepareIntegrationBindingChange(
  raw: unknown,
  writer: AdministrativeConfigurationWriter,
): Promise<IntegrationBindingIntent> {
  const input = integrationBindingInputSchema.parse(raw);
  active(writer);
  if (!writer.integrationIds.includes(input.integrationId))
    throw Error("Binding integration lock unavailable");
  return withAdministrativeConfigurationRead({}, async (read) => {
    const integration = read.integrations.find((item) => item.id === input.integrationId),
      service = input.serviceId
        ? read.services.find((item) => item.manifest.id === input.serviceId)
        : undefined;
    if (!integration?.manifest.requires?.some((item) => item.capability === input.capability))
      throw new IntegrationBindingConflict("BINDING_CAPABILITY_NOT_DECLARED");
    if (
      input.serviceId &&
      (!service?.enabled ||
        !services.getProvidedCapabilityNames(service.manifest.provides).includes(input.capability))
    )
      throw new IntegrationBindingConflict("BINDING_SERVICE_UNAVAILABLE");
    const before = capturedBindingState(read, input.integrationId);
    if (
      (before.bindings[input.capability] ?? null) !== input.expectedServiceId ||
      before.revision !== input.expectedRevision
    )
      throw new IntegrationBindingConflict();
    const nextBindings = { ...before.bindings };
    if (input.serviceId) nextBindings[input.capability] = input.serviceId;
    else delete nextBindings[input.capability];
    const change = {
        kind: "integration-binding" as const,
        ...input,
        nextVersion: randomUUID(),
        desiredRevision: bindingContentRevision(input.integrationId, nextBindings),
      },
      overlay = Object.freeze({
        purpose: "integration-binding" as const,
        coordinatorMode: "ensure-running" as const,
        changes: Object.freeze([Object.freeze(change)]),
      }) as unknown as ProspectiveConfigurationOverlay,
      registry = digest({
        integration: {
          id: integration.id,
          directory: integration.directory,
          manifest: integration.manifest,
          enabled: integration.enabled,
        },
        service: service ? { manifest: service.manifest, enabled: service.enabled } : null,
      });
    let state: State;
    const verify = async (
      actual: AdministrativeConfigurationWriter,
      candidate?: ValidatedConfigurationCandidate,
    ) => {
      if (
        actual !== writer ||
        issued.get(state.participant) !== state ||
        (candidate && candidate.operationKey !== writer.operationKey)
      )
        throw Error("Binding participant unavailable");
      active(writer);
      await withAdministrativeConfigurationRead({}, async (current) => {
        const i = current.integrations.find((item) => item.id === input.integrationId),
          s = input.serviceId
            ? current.services.find((item) => item.manifest.id === input.serviceId)
            : undefined;
        if (
          digest({
            integration: i
              ? { id: i.id, directory: i.directory, manifest: i.manifest, enabled: i.enabled }
              : null,
            service: s ? { manifest: s.manifest, enabled: s.enabled } : null,
          }) !== registry
        )
          throw new IntegrationBindingConflict("BINDING_SOURCE_CHANGED");
        if (
          !state.committed &&
          capturedBindingState(current, input.integrationId).revision !== before.revision
        )
          throw new IntegrationBindingConflict();
      });
    };
    const participant = Object.freeze({
      kind: "integration-binding",
      mode: "apply",
      actorId: writer.actorId,
      operationKey: writer.operationKey,
      managedServiceSecretKeys: Object.freeze([]),
      authorize: (actual: AdministrativeConfigurationWriter) => verify(actual),
      verify: (
        candidate: ValidatedConfigurationCandidate,
        actual: AdministrativeConfigurationWriter,
      ) => verify(actual, candidate),
      commit: async (
        candidate: ValidatedConfigurationCandidate,
        actual: AdministrativeConfigurationWriter,
        tx: ConfigurationWriteTransaction,
      ) => {
        if (state.committed || active(actual).connection !== tx)
          throw Error("Original binding transaction required");
        await verify(actual, candidate);
        const prior = before.rows.find((row) => row.capability === input.capability),
          one = (rows: unknown[]) => {
            if (rows.length !== 1) throw new IntegrationBindingConflict();
          };
        if (input.serviceId) {
          if (prior)
            one(
              await tx
                .update(capabilityBinding)
                .set({ serviceId: input.serviceId, updatedAt: new Date() })
                .where(
                  and(
                    and(
                      eq(capabilityBinding.integrationId, input.integrationId),
                      eq(capabilityBinding.capability, input.capability),
                    ),
                    sql`xmin::text=${prior._rowVersion}`,
                  ),
                )
                .returning({ id: capabilityBinding.integrationId }),
            );
          else
            one(
              await tx
                .insert(capabilityBinding)
                .values({
                  integrationId: input.integrationId,
                  capability: input.capability,
                  serviceId: input.serviceId,
                })
                .onConflictDoNothing()
                .returning({ id: capabilityBinding.integrationId }),
            );
        } else if (prior)
          one(
            await tx
              .delete(capabilityBinding)
              .where(
                and(
                  and(
                    eq(capabilityBinding.integrationId, input.integrationId),
                    eq(capabilityBinding.capability, input.capability),
                  ),
                  sql`xmin::text=${prior._rowVersion}`,
                ),
              )
              .returning({ id: capabilityBinding.integrationId }),
          );
        if (before.version)
          one(
            await tx
              .update(integrationBindingRevision)
              .set({ version: change.nextVersion, updatedAt: new Date() })
              .where(
                and(
                  eq(integrationBindingRevision.integrationId, input.integrationId),
                  eq(integrationBindingRevision.version, before.version.version),
                  sql`xmin::text=${before.version._rowVersion}`,
                ),
              )
              .returning({ id: integrationBindingRevision.integrationId }),
          );
        else
          one(
            await tx
              .insert(integrationBindingRevision)
              .values({ integrationId: input.integrationId, version: change.nextVersion })
              .onConflictDoNothing()
              .returning({ id: integrationBindingRevision.integrationId }),
          );
        const saved = await readBindingState(input.integrationId, tx);
        if (saved.desiredRevision !== change.desiredRevision)
          throw new IntegrationBindingConflict();
        const actorId = ["loopback", "internal"].includes(writer.actorId) ? null : writer.actorId;
        await tx.insert(integrationApplicationReceipt).values({
          operationId: writer.operationKey,
          actorId,
          integrationId: input.integrationId,
          capability: input.capability,
          serviceId: input.serviceId,
          candidateId: candidate.candidateId,
          intentDigest: digest(change),
          savedBindingRevision: saved.revision,
          result: {
            operationId: writer.operationKey,
            integrationId: input.integrationId,
            desiredRevision: saved.desiredRevision,
            database: "retained",
            runtime: "pending",
            runtimeGenerationId: null,
            ...(!integration.enabled ? { reason: "integration_disabled" as const } : {}),
          },
        });
        await tx.insert(adminAuditLog).values({
          id: randomUUID(),
          actorId,
          targetType: "integration",
          targetId: input.integrationId,
          action: input.serviceId ? "integration.binding.set" : "integration.binding.remove",
          details: {
            capability: input.capability,
            previousServiceId: input.expectedServiceId,
            serviceId: input.serviceId,
            operationDigest: digest(writer.operationKey),
          },
        });
        state.committed = true;
      },
    }) as unknown as ConfigurationCommitParticipant;
    state = { writer, overlay, participant, input, before, registry, committed: false };
    const intent = Object.freeze({
      [intentBrand]: true as const,
      integrationId: input.integrationId,
    });
    intents.set(intent, state);
    issued.set(participant, state);
    return intent;
  });
}
/** A verifier only: no write, participant reconstruction or mutation admission. */
export async function assertSavedIntegrationBinding(
  candidate: ValidatedConfigurationCandidate,
  rawOverlay: unknown,
  tx: ConfigurationWriteTransaction,
) {
  const overlay = z
    .strictObject({
      purpose: z.literal("integration-binding"),
      coordinatorMode: z.enum(["ensure-running", "require-running"]),
      changes: z
        .array(
          integrationBindingInputSchema.extend({
            kind: z.literal("integration-binding"),
            nextVersion: z.uuid(),
            desiredRevision: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        )
        .length(1),
    })
    .parse(rawOverlay);
  const change = overlay.changes[0];
  if (
    overlay.purpose !== "integration-binding" ||
    overlay.changes.length !== 1 ||
    change?.kind !== "integration-binding"
  )
    throw Error("Original binding overlay required");
  const [receipt] = await tx
    .select()
    .from(integrationApplicationReceipt)
    .where(eq(integrationApplicationReceipt.operationId, candidate.operationKey));
  if (
    !receipt ||
    receipt.candidateId !== candidate.candidateId ||
    receipt.integrationId !== change.integrationId ||
    receipt.intentDigest !== digest(change)
  )
    throw Error("Original binding commit receipt unavailable");
  const saved = await readBindingState(change.integrationId, tx);
  if (
    saved.revision !== receipt.savedBindingRevision ||
    saved.desiredRevision !== change.desiredRevision
  )
    throw new IntegrationBindingConflict("BINDING_SOURCE_CHANGED");
  return receipt;
}
