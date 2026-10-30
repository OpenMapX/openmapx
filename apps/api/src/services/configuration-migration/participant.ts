/** Closed staged issuers. Legacy batch intents cannot construct these participants. */
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import { and, eq, sql } from "drizzle-orm";
import { AdminActionReauthentication } from "../../account/admin-reauthentication";
import { loadAuthPolicy } from "../../account/auth-policy";
import {
  adminAuditLog,
  capabilityBinding,
  integrationBindingRevision,
  systemSettings,
} from "../../db/schema";
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
  type ConfigurationCommitParticipant,
  type ConfigurationWriteTransaction,
  withAdministrativeConfigurationRead,
} from "../administrative-configuration-writer-owner";
import { capturedBindingState } from "../integration-binding-state";
import type {
  ProspectiveConfigurationOverlay,
  ValidatedConfigurationCandidate,
} from "../prospective-configuration";
import {
  authorizePreparedFeedCredentialPatch,
  type PreparedFeedCredentialPatch,
  prepareFeedCredentialImportPatch,
  transitCredentialParticipation,
  withTransitCredentialProofContext,
} from "../transit-feed-credential-participant";
import { type CredentialPlan, prepareCredentialPlan } from "./credential-preview";
import { type MigrationPlan, prepareMigrationPlan } from "./preview";
import {
  assertRetainedMigrationStage,
  consumeMigrationStage,
  MigrationConflict,
  type MigrationStage,
  readMigrationStage,
} from "./staging";

export type MigrationPlatformAuthorization = {
  confirmations: import("@openmapx/core/api-contracts").AdminPlatformPreview["requiredConfirmation"];
  proof?: { challengeId: string; sessionId: string; nonce: Buffer };
};
export type MigrationProof = {
  sessionId: string;
  nonce: Buffer;
  importProofToken: string;
  transitProofToken?: string;
};
type State = {
  writer: AdministrativeConfigurationWriter;
  stage: MigrationStage;
  overlay: ProspectiveConfigurationOverlay;
  participant: ConfigurationCommitParticipant;
  patch?: PreparedFeedCredentialPatch;
  platform?: boolean;
  committed: boolean;
};
const issued = new WeakMap<ConfigurationCommitParticipant, State>();
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
export function isStagedMigrationParticipant(
  participant: ConfigurationCommitParticipant,
  writer: AdministrativeConfigurationWriter,
) {
  return issued.get(participant)?.writer === writer;
}
function stateFor(writer: AdministrativeConfigurationWriter) {
  const participant = administrativeConfigurationState(writer).participant,
    state = participant && issued.get(participant);
  if (!state || state.writer !== writer) throw new MigrationConflict();
  return state;
}
export function assertStagedMigrationOverlay(
  writer: AdministrativeConfigurationWriter,
  overlay: unknown,
) {
  if (canonicalJson(stateFor(writer).overlay) !== canonicalJson(overlay))
    throw new MigrationConflict();
}
export function retainedStagedMigration(writer: AdministrativeConfigurationWriter) {
  const s = stateFor(writer);
  return {
    version: 1 as const,
    kind: s.stage.kind,
    previewId: s.stage.previewId,
    integrationIds: [...writer.integrationIds],
  };
}
export function stagedMigrationPatch(writer: AdministrativeConfigurationWriter) {
  const patch = stateFor(writer).patch;
  if (!patch) throw new MigrationConflict();
  return patch;
}
export async function prepareStagedMigrationParticipant(input: {
  stage: MigrationStage;
  writer: AdministrativeConfigurationWriter;
  mode: "preview" | "apply";
  proof?: MigrationProof;
  platformAuthorization?: MigrationPlatformAuthorization;
}) {
  const { writer, stage } = input,
    owner = administrativeConfigurationState(writer),
    plan = stage.value as MigrationPlan | CredentialPlan;
  assertRetainedMigrationStage(stage);
  if (stage.actorId !== writer.actorId) throw new MigrationConflict();
  const refreshed =
    stage.kind === "migration"
      ? await prepareMigrationPlan(
          (plan as MigrationPlan).document,
          writer,
          false,
          (plan as MigrationPlan).bindingVersions,
        )
      : await prepareCredentialPlan(
          (plan as CredentialPlan).payload,
          (plan as CredentialPlan).choices,
          writer.actorId,
        );
  if (refreshed.expectedCurrentRevisionId !== plan.expectedCurrentRevisionId)
    throw new MigrationConflict();
  if (refreshed.guard !== plan.guard) throw new MigrationConflict();
  if (canonicalJson(refreshed.overlay) !== canonicalJson(plan.overlay))
    throw new MigrationConflict();
  if (stage.kind === "migration" && (plan as MigrationPlan).denials.length)
    throw new MigrationConflict();
  if (
    stage.kind === "credentials" &&
    (!(plan as CredentialPlan).choices ||
      (plan as CredentialPlan).entries.some((e) => e.status === "denied"))
  )
    throw new MigrationConflict();
  let platformScope:
      | { overlay: ProspectiveConfigurationOverlay; participant: ConfigurationCommitParticipant }
      | undefined,
    platformIntent:
      | import("../platform-configuration-participant").PlatformConfigurationIntent
      | undefined;
  let patch: PreparedFeedCredentialPatch | undefined,
    managedParticipant: ConfigurationCommitParticipant | undefined;
  const overlay = structuredClone(plan.overlay),
    credential = stage.kind === "credentials" ? (plan as CredentialPlan) : undefined;
  if (plan.platformPreview) {
    const p = plan.platformPreview!,
      authorization = input.platformAuthorization;
    if (
      input.mode === "apply" &&
      !authorization &&
      Object.values(p.requiredConfirmation).some(Boolean)
    )
      throw new MigrationConflict();
    const module = await import("../platform-configuration-participant");
    platformIntent = await module.preparePlatformConfigurationChange(
      {
        previewFingerprint: p.previewFingerprint,
        expectedCurrentRevisionId: p.expectedCurrentRevisionId,
        confirmations: authorization?.confirmations ?? {
          domain: false,
          dnsTls: false,
          oauth: false,
          passkeys: false,
          alternateLogin: false,
        },
        ...(authorization?.proof ? { proof: authorization.proof } : {}),
      },
      writer,
      {
        stage,
        mode: input.mode,
        additionalServiceIds: plan.additionalServiceIds ?? [],
      },
    );
    platformScope = module.platformConfigurationParticipation(platformIntent, writer);
    overlay.coordinatorMode = "require-running";
  }
  const proofInput = () => {
    if (!input.proof) throw new MigrationConflict();
    return {
      challengeId: input.proof.importProofToken,
      purpose: "credentials.import" as const,
      targetId: stage.previewId,
      intentFingerprint: stage.fingerprint,
      sessionId: input.proof.sessionId,
      nonce: input.proof.nonce,
    };
  };
  if (credential?.feedPreview && credential.feedChanges?.length) {
    if (!input.proof?.transitProofToken) throw new MigrationConflict();
    patch = await prepareFeedCredentialImportPatch({
      actorId: writer.actorId,
      transfer: true,
      catalogRevisionId: credential.feedPreview.catalogRevisionId,
      expectedCredentialsRevision: credential.feedPreview.credentialsRevision,
      expectedCurrentRevisionId: credential.expectedCurrentRevisionId,
      changes: credential.feedChanges,
      operationKey: writer.operationKey,
      importPreviewId: stage.previewId,
      previewOperationKey: credential.feedOperationKey,
    });
    await withTransitCredentialProofContext(
      { actorId: writer.actorId, sessionId: input.proof.sessionId, nonce: input.proof.nonce },
      () =>
        authorizePreparedFeedCredentialPatch({
          patch: patch!,
          writer,
          preview: credential.feedPreview!,
          authorization: {
            kind: "credential-import",
            transitProofToken: input.proof!.transitProofToken!,
            importProofToken: input.proof!.importProofToken,
            importPreviewId: stage.previewId,
            importFingerprint: stage.fingerprint,
          },
        }),
    );
    managedParticipant = transitCredentialParticipation(patch, writer).participant;
    overlay.changes.push(patch.overlayChange);
  } else if (credential && input.mode === "apply")
    await new AdminActionReauthentication(owner.connection).check(proofInput(), owner.connection);
  let state: State;
  const verify = async (candidate?: ValidatedConfigurationCandidate) => {
    if (
      administrativeConfigurationState(writer) !== owner ||
      (candidate && candidate.operationKey !== writer.operationKey)
    )
      throw new MigrationConflict();
    if (state.committed) return;
    if (stage.kind === "migration") {
      const migration = plan as MigrationPlan;
      if (owner.transactionMode === "write")
        await owner.connection.execute(sql`LOCK TABLE system_settings IN SHARE ROW EXCLUSIVE MODE`);
      const currentSettings = await owner.connection
        .select({ key: systemSettings.key, rowVersion: sql<string>`xmin::text` })
        .from(systemSettings);
      if (
        canonicalJson(currentSettings.sort((a, b) => a.key.localeCompare(b.key))) !==
          canonicalJson(migration.settingsWitness) ||
        (await loadAuthPolicy(owner.connection)).revision !== migration.authPolicyRevision
      )
        throw new MigrationConflict();
    }

    await readMigrationStage(
      {
        actorId: writer.actorId,
        previewId: stage.previewId,
        fingerprint: stage.fingerprint,
        kind: stage.kind,
      },
      owner.connection,
    );
    if (credential && !patch && input.mode === "apply")
      await new AdminActionReauthentication(owner.connection).check(proofInput(), owner.connection);
    if (candidate && managedParticipant) await managedParticipant.verify(candidate, writer);
    if (candidate && platformScope) await platformScope.participant.verify(candidate, writer);
  };
  const participant = Object.freeze({
    kind: stage.kind === "credentials" ? "credential-import" : "configuration-migration",
    mode: input.mode,
    actorId: writer.actorId,
    operationKey: writer.operationKey,
    managedServiceSecretKeys: patch
      ? Object.freeze([{ serviceId: "data-manager", key: "TRANSITOUS_API_KEYS" }])
      : Object.freeze([]),
    authorize: () => verify(),
    verify: (candidate: ValidatedConfigurationCandidate) => verify(candidate),
    commit: async (
      candidate: ValidatedConfigurationCandidate,
      actual: AdministrativeConfigurationWriter,
      tx: ConfigurationWriteTransaction,
    ) => {
      if (
        actual !== writer ||
        owner.connection !== tx ||
        !owner.transactionActive ||
        owner.transactionMode !== "write" ||
        input.mode !== "apply"
      )
        throw new MigrationConflict();
      await verify(candidate);
      if (credential && !patch)
        await new AdminActionReauthentication(owner.connection).consume(
          proofInput(),
          owner.connection,
        );
      if (platformScope) await platformScope.participant.commit(candidate, writer, tx);
      if (stage.kind === "migration") {
        const config = plan as MigrationPlan;
        for (const [key, value] of Object.entries(config.settings))
          await tx
            .insert(systemSettings)
            .values({ key, value })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value, updatedAt: new Date() },
            });
        const groups = new Set(config.document.bindings.map((b) => b.integrationId));
        for (const id of groups) {
          const before = await withAdministrativeConfigurationRead({}, async (read) =>
            capturedBindingState(read, id),
          );
          const first = overlay.changes.find(
            (c) => c.kind === "integration-binding" && c.integrationId === id,
          );
          if (
            !first ||
            first.kind !== "integration-binding" ||
            before.revision !== first.expectedRevision
          )
            throw new MigrationConflict();
          for (const binding of config.document.bindings.filter((b) => b.integrationId === id))
            await tx
              .insert(capabilityBinding)
              .values(binding)
              .onConflictDoUpdate({
                target: [capabilityBinding.integrationId, capabilityBinding.capability],
                set: { serviceId: binding.serviceId, updatedAt: new Date() },
              });
          await tx
            .insert(integrationBindingRevision)
            .values({ integrationId: id, version: config.bindingVersions[id]! })
            .onConflictDoUpdate({
              target: integrationBindingRevision.integrationId,
              set: { version: config.bindingVersions[id]!, updatedAt: new Date() },
            });
        }
      }
      await tx.insert(adminAuditLog).values({
        id: randomUUID(),
        actorId: writer.actorId,
        action:
          stage.kind === "credentials"
            ? "credentials.import.desired"
            : "configuration.migration.desired",
        targetType: "configuration-migration",
        targetId: stage.previewId,
        details: {
          jobId: owner.job.jobId,
          candidateId: candidate.candidateId,
          selected: overlay.changes.map((c) => ({
            kind: c.kind,
            id:
              "integrationId" in c ? c.integrationId : "serviceId" in c ? c.serviceId : "platform",
            keys:
              "set" in c
                ? Object.keys(c.set)
                : "key" in c
                  ? [c.key]
                  : "capability" in c
                    ? [c.capability]
                    : [],
          })),
        },
      });
      await consumeMigrationStage(stage, owner.job.jobId, tx, {
        candidateId: candidate.candidateId,
        settingsKeys:
          stage.kind === "migration" ? Object.keys((plan as MigrationPlan).settings) : [],
        integrationIds:
          stage.kind === "migration"
            ? [...new Set((plan as MigrationPlan).document.bindings.map((b) => b.integrationId))]
            : [],
      });
      state.committed = true;
    },
  }) as unknown as ConfigurationCommitParticipant;
  immutable(overlay);
  state = {
    writer,
    stage,
    overlay,
    participant,
    ...(patch ? { patch } : {}),
    ...(platformScope ? { platform: true } : {}),
    committed: false,
  };
  issued.set(participant, state);
  if (platformIntent) {
    const module = await import("../platform-configuration-participant");
    await module.bindStagedMigrationPlatform(platformIntent, participant, writer);
  }
  return { overlay, participant };
}

export function stagedMigrationHasPlatform(writer: AdministrativeConfigurationWriter) {
  return stateFor(writer).platform === true;
}

export function retainedStagedMigrationSource(writer: AdministrativeConfigurationWriter) {
  return (stateFor(writer).stage.value as MigrationPlan | CredentialPlan).sourceSnapshot;
}
