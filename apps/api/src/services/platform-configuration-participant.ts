/** Sole built-in platform issuer. Parsed previews/overlays and copied objects
 * are data; only this writer-bound instance participates in a desired save. */
import { randomUUID } from "node:crypto";
import type { AdminPlatformPreview } from "@openmapx/core/api-contracts";
import { type ConfigurationSourcesInspection, canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { eq, sql } from "drizzle-orm";
import { AdminActionReauthentication } from "../account/admin-reauthentication";
import { loadAuthPolicy } from "../account/auth-policy";
import { platformConfigurationPreview, systemSettings } from "../db/schema";
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
  type ConfigurationCommitParticipant,
  type ConfigurationWriteTransaction,
} from "./administrative-configuration-writer-owner";
import {
  commitPlatformConfigurationIntent,
  PLATFORM_CONFIGURATION_SETTING,
  type PlatformConfigurationCommitInput,
} from "./platform-configuration";
import { PlatformPreviewConflict, readPlatformPreview } from "./platform-preview-store";
import type {
  ProspectiveConfigurationOverlay,
  ValidatedConfigurationCandidate,
} from "./prospective-configuration";
import { encrypt } from "./secrets";

declare const intentBrand: unique symbol;
export interface PlatformConfigurationIntent {
  readonly [intentBrand]: true;
}
interface State {
  writer: AdministrativeConfigurationWriter;
  input: Pick<
    PlatformConfigurationCommitInput,
    "previewFingerprint" | "expectedCurrentRevisionId" | "confirmations" | "proof"
  >;
  preview: AdminPlatformPreview;
  expectedDesiredRowVersion: string | null;
  handoffId: string;
  authorization?: ReturnType<typeof encrypt>;
  overlay: ProspectiveConfigurationOverlay;
  participant: ConfigurationCommitParticipant;
  committed?: { candidateId: string; revisionId: string; rowVersion: string };
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const intents = new WeakMap<PlatformConfigurationIntent, State>(),
  participants = new WeakMap<ConfigurationCommitParticipant, State>();
function active(writer: AdministrativeConfigurationWriter) {
  const owner = administrativeConfigurationState(writer);
  if (owner.job.jobType !== "platform.apply" || !owner.job.execution)
    throw new PlatformPreviewConflict();
  return owner;
}
export function isPlatformConfigurationParticipant(
  participant: ConfigurationCommitParticipant,
  writer: AdministrativeConfigurationWriter,
) {
  return participants.get(participant)?.writer === writer;
}
function stateFor(writer: AdministrativeConfigurationWriter) {
  const owner = active(writer),
    state = owner.participant && participants.get(owner.participant);
  if (!state || state.writer !== writer) throw new PlatformPreviewConflict();
  return state;
}
export function assertPlatformConfigurationOverlay(
  writer: AdministrativeConfigurationWriter,
  overlay: unknown,
) {
  const state = stateFor(writer);
  if (canonicalJson(overlay) !== canonicalJson(state.overlay)) throw new PlatformPreviewConflict();
}
export function platformConfigurationParticipation(
  intent: PlatformConfigurationIntent,
  writer: AdministrativeConfigurationWriter,
) {
  const state = intents.get(intent);
  if (!state || state.writer !== writer) throw new PlatformPreviewConflict();
  active(writer);
  return { overlay: state.overlay, participant: state.participant };
}
/** Private, encrypted restart context is counted by the existing candidate's
 * size/queue budget. It never enters the public job payload or preview DTO. */
export function retainedPlatformConfigurationIntent(writer: AdministrativeConfigurationWriter) {
  const state = stateFor(writer),
    { preview } = state;
  return {
    version: 1 as const,
    handoffId: state.handoffId,
    previewId: preview.previewId,
    previewFingerprint: preview.previewFingerprint,
    authPolicyRevision: preview.authPolicyRevision,
    sourceRevision: preview.sourceRevision,
    expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
    configuration: structuredClone(preview.configuration),
    affectedServiceIds: [...preview.affectedServiceIds],
    expectedDesiredRowVersion: state.expectedDesiredRowVersion,
    confirmations: { ...state.input.confirmations },
    ...(state.authorization ? { authorization: { ...state.authorization } } : {}),
  };
}
export function assertPlatformConfigurationSource(
  writer: AdministrativeConfigurationWriter,
  source: ConfigurationSourcesInspection,
  input: {
    env: Readonly<Record<string, string | undefined>>;
    services: Parameters<typeof services.buildPlatformConfigurationPreview>[0]["services"];
    resolvedServiceConfigs: Map<string, Record<string, unknown>>;
  },
) {
  const state = stateFor(writer),
    p = state.preview;
  const rebuilt = services.buildPlatformConfigurationPreview({
    actorId: writer.actorId,
    previewId: p.previewId,
    authPolicyRevision: p.authPolicyRevision,
    sourceRevision: source.sourceRevision,
    currentRevisionId: source.revisionId,
    expectedCurrentRevisionId: p.expectedCurrentRevisionId,
    currentPlatform: source.platform,
    changes: p.configuration,
    ...input,
  });
  if (rebuilt.previewFingerprint !== p.previewFingerprint) throw new PlatformPreviewConflict();
}
export async function preparePlatformConfigurationChange(
  input: Pick<
    PlatformConfigurationCommitInput,
    "previewFingerprint" | "expectedCurrentRevisionId" | "confirmations" | "proof"
  >,
  writer: AdministrativeConfigurationWriter,
): Promise<PlatformConfigurationIntent> {
  const owner = active(writer),
    retained = await readPlatformPreview(
      { actorId: writer.actorId, previewFingerprint: input.previewFingerprint },
      owner.connection,
    ),
    preview = immutable(retained.preview);
  if (
    retained.consumedByJobId ||
    preview.expectedCurrentRevisionId !== input.expectedCurrentRevisionId ||
    preview.authPolicyRevision !== (await loadAuthPolicy(owner.connection)).revision ||
    Object.entries(preview.requiredConfirmation).some(
      ([key, required]) =>
        required && input.confirmations[key as keyof typeof input.confirmations] !== true,
    )
  )
    throw new PlatformPreviewConflict();
  const proof = input.proof ? { ...input.proof, nonce: Buffer.from(input.proof.nonce) } : undefined;
  if (preview.requiredConfirmation.domain) {
    if (!proof) throw new PlatformPreviewConflict("Domain recovery proof required");
    await new AdminActionReauthentication(owner.connection).check(
      {
        ...proof,
        purpose: "platform.domain.apply",
        targetId: preview.previewFingerprint,
        intentFingerprint: preview.previewFingerprint,
      },
      owner.connection,
    );
  }
  const [desired] = await owner.connection
    .select({ version: sql<string>`xmin::text` })
    .from(systemSettings)
    .where(eq(systemSettings.key, PLATFORM_CONFIGURATION_SETTING));
  const { version: _version, ...patch } = preview.configuration;
  const overlay: ProspectiveConfigurationOverlay = immutable({
    purpose: "platform",
    coordinatorMode: "require-running",
    changes: [{ kind: "platform", patch }],
  });
  let state: State;
  const verify = async (
    actual: AdministrativeConfigurationWriter,
    candidate?: ValidatedConfigurationCandidate,
  ) => {
    if (actual !== writer || participants.get(state.participant) !== state)
      throw new PlatformPreviewConflict();
    const current = active(writer);
    if (state.committed) {
      const [saved] = await current.connection
        .select({ value: systemSettings.value, version: sql<string>`xmin::text` })
        .from(systemSettings)
        .where(eq(systemSettings.key, PLATFORM_CONFIGURATION_SETTING));
      const [consumed] = await current.connection
        .select()
        .from(platformConfigurationPreview)
        .where(eq(platformConfigurationPreview.id, preview.previewId));
      if (
        !candidate ||
        candidate.candidateId !== state.committed.candidateId ||
        candidate.revisionId !== state.committed.revisionId ||
        consumed?.consumedByJobId !== current.job.jobId ||
        consumed.previewFingerprint !== preview.previewFingerprint ||
        saved?.version !== state.committed.rowVersion ||
        canonicalJson(saved.value) !==
          canonicalJson({
            version: 1,
            jobId: current.job.jobId,
            candidateId: candidate.candidateId,
            revisionId: candidate.revisionId,
            previewFingerprint: preview.previewFingerprint,
            configuration: preview.configuration,
          })
      )
        throw new PlatformPreviewConflict();
      return;
    }
    const stored = await readPlatformPreview(
      { actorId: writer.actorId, previewFingerprint: preview.previewFingerprint },
      current.connection,
    );
    if (
      stored.consumedByJobId ||
      canonicalJson(stored.preview) !== canonicalJson(preview) ||
      (await loadAuthPolicy(current.connection)).revision !== preview.authPolicyRevision
    )
      throw new PlatformPreviewConflict();
    const [desired] = await current.connection
      .select({ version: sql<string>`xmin::text` })
      .from(systemSettings)
      .where(eq(systemSettings.key, PLATFORM_CONFIGURATION_SETTING));
    if ((desired?.version ?? null) !== state.expectedDesiredRowVersion)
      throw new PlatformPreviewConflict();
    if (proof && preview.requiredConfirmation.domain)
      await new AdminActionReauthentication(current.connection).check(
        {
          ...proof,
          purpose: "platform.domain.apply",
          targetId: preview.previewFingerprint,
          intentFingerprint: preview.previewFingerprint,
        },
        current.connection,
      );
    if (
      candidate &&
      (candidate.operationKey !== writer.operationKey ||
        candidate.expectedCurrentRevisionId !== preview.expectedCurrentRevisionId)
    )
      throw new PlatformPreviewConflict();
  };
  const participant = Object.freeze({
    kind: "platform",
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
      const current = active(actual);
      if (
        actual !== writer ||
        current.connection !== tx ||
        !current.transactionActive ||
        current.transactionMode !== "write"
      )
        throw new PlatformPreviewConflict();
      await verify(actual, candidate);
      const saved = await commitPlatformConfigurationIntent(
        {
          actorId: writer.actorId,
          jobId: current.job.jobId,
          execution: current.job.execution!,
          candidateId: candidate.candidateId,
          revisionId: candidate.revisionId,
          expectedAuthPolicyRevision: preview.authPolicyRevision,
          sourceRevision: preview.sourceRevision,
          expectedDesiredRowVersion: state.expectedDesiredRowVersion,
          ...state.input,
        },
        current.connection,
      );
      state.committed = {
        candidateId: candidate.candidateId,
        revisionId: candidate.revisionId,
        rowVersion: saved.rowVersion,
      };
    },
  }) as unknown as ConfigurationCommitParticipant;
  state = {
    writer,
    input: {
      previewFingerprint: input.previewFingerprint,
      expectedCurrentRevisionId: input.expectedCurrentRevisionId,
      confirmations: { ...input.confirmations },
      ...(proof ? { proof } : {}),
    },
    preview,
    expectedDesiredRowVersion: desired?.version ?? null,
    handoffId: randomUUID(),
    overlay,
    participant,
    ...(proof
      ? {
          authorization: encrypt(
            canonicalJson({
              version: 1,
              actorId: writer.actorId,
              jobId: owner.job.jobId,
              operationKey: writer.operationKey,
              previewFingerprint: preview.previewFingerprint,
              challengeId: proof.challengeId,
              sessionId: proof.sessionId,
              nonce: proof.nonce.toString("base64"),
            }),
          ),
        }
      : {}),
  };
  const intent = Object.freeze({}) as PlatformConfigurationIntent;
  intents.set(intent, state);
  participants.set(participant, state);
  return intent;
}
