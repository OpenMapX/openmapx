/** One finite managed-map adapter in the existing configuration writer/transaction. */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import {
  type FeedCredentialChange,
  parseFeedCredentialMapJson,
  validateFeedCredentialMap,
} from "@openmapx/transitous-core/feed-credentials";
import { and, eq, sql } from "drizzle-orm";
import { AdminActionReauthentication } from "../account/admin-reauthentication";
import type { AuthDatabase } from "../account/auth-database";
import { adminAuditLog, serviceSecret, transitCredentialPreview } from "../db/schema";
import {
  type AdministrativeConfigurationWriter,
  administrativeConfigurationState,
  type ConfigurationCommitParticipant,
  type ConfigurationWriteTransaction,
  currentAdministrativeConfigurationWriter,
  withAdministrativeConfigurationRead,
} from "./administrative-configuration-writer-owner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import type {
  ProspectiveConfigurationOverlay,
  ValidatedConfigurationCandidate,
} from "./prospective-configuration";
import { decrypt } from "./secrets";
import {
  type FeedCredentialChangePreview,
  readFeedCredentialPreview,
  retainFeedCredentialPreview,
  TransitCredentialConflict,
} from "./transit-credential-preview";
import { transitCredentialRevision } from "./transit-credential-revision";
import type { TrustedConfigurationApplyOutcome } from "./trusted-config-outcome";

export type { FeedCredentialChangePreview } from "./transit-credential-preview";

const SERVICE = "data-manager" as const,
  KEY = "TRANSITOUS_API_KEYS" as const;
export type FeedCredentialAuthorization =
  | { kind: "direct"; transitProofToken: string }
  | {
      kind: "credential-import";
      transitProofToken: string;
      importProofToken: string;
      importPreviewId: string;
      importFingerprint: string;
    };
export interface FeedCredentialApplyResult {
  credentialsRevision: string;
  configuration: TrustedConfigurationApplyOutcome;
}
interface ServerProofContext {
  actorId: string;
  sessionId: string;
  nonce: Buffer;
}
const proofContexts = new AsyncLocalStorage<ServerProofContext>();
/** Set only by authenticated HTTP/job adapters, never from a request body. */
export function withTransitCredentialProofContext<T>(
  context: ServerProofContext,
  run: () => Promise<T>,
) {
  return proofContexts.run(context, run);
}
async function inspect(
  catalogRevisionId: string,
  identity: string,
  signal?: AbortSignal,
  proposalId?: string,
) {
  return executeAndWait(
    createApiOpsClient(),
    {
      kind: "transitCredentials.inspect",
      catalogRevisionId,
      ...(proposalId ? { proposalId } : {}),
    },
    createDurableOpsKey("transit.credentials.inspect", identity),
    { signal },
  );
}
function rowFrom(read: { serviceSecretRows: readonly (typeof serviceSecret.$inferSelect)[] }) {
  return read.serviceSecretRows.find((row) => row.serviceId === SERVICE && row.key === KEY);
}
function values(row: typeof serviceSecret.$inferSelect | undefined) {
  return row ? parseFeedCredentialMapJson(decrypt(row.ciphertext, row.iv, row.tag)) : {};
}
export async function inspectFeedCredentials(input: {
  catalogRevisionId: string;
  proposalId?: string;
  signal?: AbortSignal;
}) {
  const host = await inspect(
    input.catalogRevisionId,
    `read:${input.catalogRevisionId}`,
    input.signal,
    input.proposalId,
  );
  const current = await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.inspect" },
    createDurableOpsKey("transit.credentials.configuration", input.catalogRevisionId),
    { signal: input.signal },
  );
  return withAdministrativeConfigurationRead({}, async (read) => {
    const row = rowFrom(read),
      map = values(row),
      revision = transitCredentialRevision(row);
    if (host.owner === "vault" && !row)
      throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_UNAVAILABLE");
    const keys = [
      ...new Set([...host.requiredKeys, ...Object.keys(map), ...host.retainedKeys]),
    ].sort();
    const configured = new Set(
      host.editable ? Object.keys(map).filter((key) => map[key] !== "") : host.configuredKeys,
    );
    return {
      catalogRevisionId: input.catalogRevisionId,
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      credentialsRevision:
        host.owner === "file" ? (host.hostCredentialsRevision ?? revision) : revision,
      configurationRevisionId: current.revisionId,
      owner: host.owner === "unset" && row ? ("vault" as const) : host.owner,
      editable: host.editable,
      reason: host.reason,
      appliedCredentialsRevision: host.appliedCredentialsRevision,
      pendingApplication: Boolean(row) && host.appliedCredentialsRevision !== revision,
      entries: keys.map((key) => ({
        key,
        required: host.requiredKeys.includes(key),
        configured: configured.has(key),
        orphaned: !host.requiredKeys.includes(key),
      })),
    };
  });
}
interface ChangeInput {
  /** Set only by the finite encrypted transfer coordinator; direct routes stay bounded at100. */
  transfer?: true;
  previewOperationKey?: string;
  actorId: string;
  catalogRevisionId: string;
  proposalId?: string;
  expectedCredentialsRevision: string;
  expectedCurrentRevisionId: string | null;
  changes: FeedCredentialChange[];
  operationKey: string;
  signal?: AbortSignal;
}
async function validateInput(input: ChangeInput) {
  const host = await inspect(
    input.catalogRevisionId,
    input.operationKey,
    input.signal,
    input.proposalId,
  );
  if (!host.editable) throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_HOST_OWNED");
  return withAdministrativeConfigurationRead({}, async (read) => {
    const row = rowFrom(read),
      revision = transitCredentialRevision(row),
      existing = values(row);
    if (revision !== input.expectedCredentialsRevision) throw new TransitCredentialConflict();
    for (const change of input.changes)
      if (!Object.hasOwn(existing, change.key) && !host.requiredKeys.includes(change.key))
        throw new TransitCredentialConflict("TRANSIT_CREDENTIAL_KEY_NOT_IN_CATALOG");
    const next = validateFeedCredentialMap(existing, input.changes, input.transfer ? 1000 : 100);
    return { host, row, revision, existing, next };
  });
}
export async function previewFeedCredentialChanges(
  input: ChangeInput,
): Promise<FeedCredentialChangePreview> {
  const value = await validateInput(input);
  const current = await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.inspect" },
    createDurableOpsKey("transit.credentials.preview", input.operationKey),
    { signal: input.signal },
  );
  if (current.revisionId !== input.expectedCurrentRevisionId) throw new TransitCredentialConflict();
  return retainFeedCredentialPreview({
    ...input,
    credentialsRevision: value.revision,
    preservedCount: Object.keys(value.existing).filter(
      (key) => !input.changes.some((change) => change.key === key),
    ).length,
    mapBytes: value.next.utf8Bytes,
  });
}
declare const patchBrand: unique symbol;
export interface PreparedFeedCredentialPatch {
  readonly [patchBrand]: true;
  readonly serviceId: typeof SERVICE;
  readonly key: typeof KEY;
  readonly catalogRevisionId: string;
  readonly proposalId?: string;
  readonly expectedCredentialsRevision: string;
  readonly expectedCurrentRevisionId: string | null;
  readonly importPreviewId: string;
  readonly operationKey: string;
  readonly overlayChange: Extract<
    ProspectiveConfigurationOverlay["changes"][number],
    { kind: "service-secret" }
  >;
}
interface PatchState {
  writer: AdministrativeConfigurationWriter;
  input: ChangeInput;
  patch: PreparedFeedCredentialPatch;
  row: typeof serviceSecret.$inferSelect | undefined;
  authorization?: FeedCredentialAuthorization;
  proof?: ServerProofContext;
  preview?: FeedCredentialChangePreview;
  committedRevision?: string;
  candidateId?: string;
}
const patches = new WeakMap<PreparedFeedCredentialPatch, PatchState>(),
  participants = new WeakMap<ConfigurationCommitParticipant, PatchState>();
export async function prepareFeedCredentialImportPatch(
  input: ChangeInput & { importPreviewId: string },
): Promise<PreparedFeedCredentialPatch> {
  const writer = currentAdministrativeConfigurationWriter();
  if (writer.actorId !== input.actorId || writer.operationKey !== input.operationKey)
    throw new TransitCredentialConflict();
  const value = await validateInput(input);
  const overlayChange = Object.freeze({
    kind: "service-secret" as const,
    serviceId: SERVICE,
    key: KEY,
    action: "set" as const,
    value: value.next.canonicalJson,
  });
  const patch = Object.freeze({
    serviceId: SERVICE,
    key: KEY,
    catalogRevisionId: input.catalogRevisionId,
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    expectedCredentialsRevision: input.expectedCredentialsRevision,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    importPreviewId: input.importPreviewId,
    operationKey: input.operationKey,
    overlayChange,
  }) as PreparedFeedCredentialPatch;
  patches.set(patch, {
    writer,
    input: structuredClone({ ...input, signal: undefined }),
    patch,
    row: value.row,
  });
  return patch;
}
function owned(patch: PreparedFeedCredentialPatch, writer: AdministrativeConfigurationWriter) {
  const state = patches.get(patch);
  if (
    !state ||
    state.writer !== writer ||
    writer.actorId !== state.input.actorId ||
    writer.operationKey !== patch.operationKey
  )
    throw new TransitCredentialConflict();
  administrativeConfigurationState(writer);
  return state;
}
function proofInput(state: PatchState) {
  const authorization = state.authorization,
    context = state.proof,
    preview = state.preview;
  if (!authorization || !context || !preview)
    throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_PROOF_REQUIRED");
  const transit = {
    challengeId: authorization.transitProofToken,
    purpose: "transit.credentials" as const,
    targetId: state.input.catalogRevisionId,
    intentFingerprint:
      authorization.kind === "credential-import"
        ? authorization.importFingerprint
        : preview.intentFingerprint,
  };
  return {
    nonce: context.nonce,
    sessionId: context.sessionId,
    proofs:
      authorization.kind === "direct"
        ? [transit]
        : [
            transit,
            {
              challengeId: authorization.importProofToken,
              purpose: "credentials.import" as const,
              targetId: authorization.importPreviewId,
              intentFingerprint: authorization.importFingerprint,
            },
          ],
  };
}
async function proof(state: PatchState, consume: boolean, tx: AuthDatabase) {
  const input = proofInput(state),
    verifier = new AdminActionReauthentication(tx);
  if (input.proofs.length === 1) {
    const single = { ...input.proofs[0]!, nonce: input.nonce, sessionId: input.sessionId };
    await (consume ? verifier.consume(single, tx) : verifier.check(single, tx));
  } else await (consume ? verifier.consumeMany(input, tx) : verifier.checkMany(input, tx));
}
/** 04.6 calls this once before preparing its whole mixed candidate; no nested participant. */
export async function authorizePreparedFeedCredentialPatch(input: {
  patch: PreparedFeedCredentialPatch;
  writer: AdministrativeConfigurationWriter;
  authorization: FeedCredentialAuthorization;
  preview: FeedCredentialChangePreview;
}) {
  const state = owned(input.patch, input.writer),
    context = proofContexts.getStore();
  if (
    !context ||
    context.actorId !== state.input.actorId ||
    input.preview.catalogRevisionId !== state.input.catalogRevisionId ||
    input.preview.proposalId !== state.input.proposalId ||
    input.preview.credentialsRevision !== state.input.expectedCredentialsRevision ||
    input.preview.expectedCurrentRevisionId !== state.input.expectedCurrentRevisionId ||
    (input.authorization.kind === "direct"
      ? input.preview.previewId
      : input.authorization.importPreviewId) !== state.patch.importPreviewId
  )
    throw new TransitCredentialConflict();
  const stored = await readFeedCredentialPreview(
    {
      actorId: state.input.actorId,
      previewId: input.preview.previewId,
      intentFingerprint: input.preview.intentFingerprint,
      operationKey:
        input.authorization.kind === "credential-import"
          ? (state.input.previewOperationKey ?? state.input.operationKey)
          : state.input.operationKey,
    },
    administrativeConfigurationState(input.writer).connection,
  );
  if (
    stored.row.consumedAt ||
    stored.row.expiresAt <= new Date() ||
    canonicalJson(stored.private.preview) !== canonicalJson(input.preview) ||
    canonicalJson(stored.private.changes) !== canonicalJson(state.input.changes)
  )
    throw new TransitCredentialConflict();
  state.authorization = Object.freeze({ ...input.authorization });
  state.proof = {
    actorId: context.actorId,
    sessionId: context.sessionId,
    nonce: Buffer.from(context.nonce),
  };
  state.preview = Object.freeze({ ...input.preview });
  await proof(state, false, administrativeConfigurationState(input.writer).connection);
}
export function isTransitCredentialParticipant(
  participant: ConfigurationCommitParticipant,
  writer: AdministrativeConfigurationWriter,
) {
  return participants.get(participant)?.writer === writer;
}
export function assertTransitCredentialOverlay(
  writer: AdministrativeConfigurationWriter,
  overlay: unknown,
) {
  const owner = administrativeConfigurationState(writer),
    state = owner.participant && participants.get(owner.participant);
  if (
    !state ||
    state.writer !== writer ||
    canonicalJson(overlay) !==
      canonicalJson({
        purpose: "transit-credentials",
        coordinatorMode: "require-running",
        changes: [state.patch.overlayChange],
      })
  )
    throw new TransitCredentialConflict();
}
export function transitCredentialParticipation(
  patch: PreparedFeedCredentialPatch,
  writer: AdministrativeConfigurationWriter,
) {
  const state = owned(patch, writer);
  if (!state.authorization)
    throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_PROOF_REQUIRED");
  const verify = async (candidate?: ValidatedConfigurationCandidate) => {
    owned(patch, writer);
    if (candidate && candidate.operationKey !== writer.operationKey)
      throw new TransitCredentialConflict();
    const current = await inspect(
      patch.catalogRevisionId,
      writer.operationKey,
      administrativeConfigurationState(writer).job.signal,
      state.input.proposalId,
    );
    if (!current.editable) throw new TransitCredentialConflict("TRANSIT_CREDENTIALS_HOST_OWNED");
    await withAdministrativeConfigurationRead({}, async (read) => {
      if (
        transitCredentialRevision(rowFrom(read)) !==
        (state.committedRevision ?? patch.expectedCredentialsRevision)
      )
        throw new TransitCredentialConflict();
    });
    if (!state.committedRevision)
      await proof(state, false, administrativeConfigurationState(writer).connection);
  };
  const participant = Object.freeze({
    kind: "transit-credentials",
    mode: "apply",
    actorId: writer.actorId,
    operationKey: writer.operationKey,
    managedServiceSecretKeys: Object.freeze([{ serviceId: SERVICE, key: KEY }]),
    authorize: async () => verify(),
    verify: async (
      candidate: ValidatedConfigurationCandidate,
      actual: AdministrativeConfigurationWriter,
    ) => {
      if (actual !== writer) throw new TransitCredentialConflict();
      await verify(candidate);
    },
    commit: async (
      candidate: ValidatedConfigurationCandidate,
      actual: AdministrativeConfigurationWriter,
      tx: ConfigurationWriteTransaction,
    ) => {
      if (actual !== writer || administrativeConfigurationState(writer).connection !== tx)
        throw new TransitCredentialConflict();
      await verify(candidate);
    },
  }) as unknown as ConfigurationCommitParticipant;
  participants.set(participant, state);
  return {
    overlay: {
      purpose: "transit-credentials",
      coordinatorMode: "require-running",
      changes: [patch.overlayChange],
    } as ProspectiveConfigurationOverlay,
    participant,
  };
}
export async function persistPreparedFeedCredentialRow(input: {
  patch: PreparedFeedCredentialPatch;
  candidate: ValidatedConfigurationCandidate;
  writer: AdministrativeConfigurationWriter;
  candidateState: {
    writer: AdministrativeConfigurationWriter;
    rows: { serviceSecretRows: readonly (typeof serviceSecret.$inferSelect)[] } | null;
    sourceRows: { serviceSecretRows: readonly (typeof serviceSecret.$inferSelect)[] } | null;
    payload: { transitCredentialsRevision?: string };
    overlay: ProspectiveConfigurationOverlay;
  };
}): Promise<{ credentialsRevision: string }> {
  const state = owned(input.patch, input.writer),
    owner = administrativeConfigurationState(input.writer);
  if (
    !owner.transactionActive ||
    owner.transactionMode !== "write" ||
    !owner.participant?.managedServiceSecretKeys.some(
      (item) => item.serviceId === SERVICE && item.key === KEY,
    ) ||
    state.committedRevision
  )
    throw new TransitCredentialConflict();
  const { candidateState: candidate } = input;
  const next = candidate.rows?.serviceSecretRows.find(
      (row) => row.serviceId === SERVICE && row.key === KEY,
    ),
    before = candidate.sourceRows?.serviceSecretRows.find(
      (row) => row.serviceId === SERVICE && row.key === KEY,
    );
  if (
    candidate.writer !== input.writer ||
    input.candidate.operationKey !== input.patch.operationKey ||
    !next ||
    transitCredentialRevision(before) !== input.patch.expectedCredentialsRevision ||
    input.patch.overlayChange.action !== "set" ||
    decrypt(next.ciphertext, next.iv, next.tag) !== input.patch.overlayChange.value ||
    candidate.payload.transitCredentialsRevision !== transitCredentialRevision(next) ||
    !candidate.overlay.changes.some(
      (change) => canonicalJson(change) === canonicalJson(input.patch.overlayChange),
    )
  )
    throw new TransitCredentialConflict();
  const tx = owner.connection;
  await proof(state, true, tx);
  const revision = transitCredentialRevision(next);
  const changed = before
    ? await tx
        .update(serviceSecret)
        .set({
          ciphertext: next.ciphertext,
          iv: next.iv,
          tag: next.tag,
          updatedBy: input.writer.actorId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(serviceSecret.id, before.id),
            sql`xmin::text = ${(before as typeof before & { _rowVersion?: string })._rowVersion}`,
          ),
        )
        .returning({ id: serviceSecret.id })
    : await tx
        .insert(serviceSecret)
        .values({ ...next, updatedBy: input.writer.actorId })
        .onConflictDoNothing()
        .returning({ id: serviceSecret.id });
  if (changed.length !== 1) throw new TransitCredentialConflict();
  const marked = await tx
    .update(transitCredentialPreview)
    .set({
      consumedAt: new Date(),
      candidateId: input.candidate.candidateId,
      credentialsRevision: revision,
    })
    .where(
      and(
        eq(transitCredentialPreview.id, state.preview!.previewId),
        eq(transitCredentialPreview.actorId, input.writer.actorId),
        eq(transitCredentialPreview.intentFingerprint, state.preview!.intentFingerprint),
        sql`${transitCredentialPreview.consumedAt} is null`,
        sql`${transitCredentialPreview.expiresAt} > now()`,
      ),
    )
    .returning({ id: transitCredentialPreview.id });
  if (marked.length !== 1) throw new TransitCredentialConflict();
  await tx.insert(adminAuditLog).values({
    id: randomUUID(),
    action: "transit.credentials.update",
    actorId: input.writer.actorId,
    targetType: "transit.credentials",
    targetId: state.input.catalogRevisionId,
    details: { changes: state.input.changes.map(({ key, action }) => ({ key, action })) },
  });
  // This is proposed commit state only; the actual persistence wrapper owns SQL
  // rollback/unknown handling and must not retry a consumed decision as fresh work.
  state.committedRevision = revision;
  state.candidateId = input.candidate.candidateId;
  return { credentialsRevision: revision };
}

export function transitParticipantPatch(
  participant: ConfigurationCommitParticipant,
  writer: AdministrativeConfigurationWriter,
): PreparedFeedCredentialPatch {
  const state = participants.get(participant);
  if (!state || state.writer !== writer) throw new TransitCredentialConflict();
  owned(state.patch, writer);
  return state.patch;
}
