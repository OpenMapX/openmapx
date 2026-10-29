/** Public orchestration over the sole finite participant and original candidate writer. */
import {
  administrativeConfigurationState,
  currentAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer-owner";
import { readFeedCredentialPreview, TransitCredentialConflict } from "./transit-credential-preview";
import {
  authorizePreparedFeedCredentialPatch,
  type FeedCredentialApplyResult,
  type FeedCredentialAuthorization,
  prepareFeedCredentialImportPatch,
  transitCredentialParticipation,
} from "./transit-feed-credential-participant";

export { persistPreparedFeedCredentialPatch } from "./prospective-configuration";
export * from "./transit-feed-credential-participant";
export async function applyFeedCredentialChanges(input: {
  actorId: string;
  previewId: string;
  intentFingerprint: string;
  operationKey: string;
  authorization: FeedCredentialAuthorization;
  signal?: AbortSignal;
}): Promise<FeedCredentialApplyResult> {
  const writer = currentAdministrativeConfigurationWriter(),
    stored = await readFeedCredentialPreview(
      input,
      administrativeConfigurationState(writer).connection,
    );
  if (stored.row.expiresAt <= new Date() || stored.row.consumedAt)
    throw new TransitCredentialConflict();
  const p = stored.private,
    patch = await prepareFeedCredentialImportPatch({
      actorId: input.actorId,
      catalogRevisionId: p.preview.catalogRevisionId,
      ...(p.preview.proposalId ? { proposalId: p.preview.proposalId } : {}),
      expectedCredentialsRevision: p.preview.credentialsRevision,
      expectedCurrentRevisionId: p.preview.expectedCurrentRevisionId,
      changes: p.changes,
      operationKey: input.operationKey,
      importPreviewId: input.previewId,
      signal: input.signal,
    });
  await authorizePreparedFeedCredentialPatch({
    patch,
    writer,
    authorization: input.authorization,
    preview: p.preview,
  });
  const scope = transitCredentialParticipation(patch, writer);
  const { withConfigurationCommitParticipant } = await import("./configuration-commit-participant");
  return withConfigurationCommitParticipant(writer, scope.participant, async () => {
    const { prepareProspectiveConfiguration, persistAndApplyProspectiveConfiguration } =
      await import("./prospective-configuration");
    const candidate = await prepareProspectiveConfiguration({
      actorId: input.actorId,
      operationKey: input.operationKey,
      expectedCurrentRevisionId: p.preview.expectedCurrentRevisionId,
      overlay: scope.overlay,
      followUp: "service-apply",
      signal: input.signal,
    });
    const result = await persistAndApplyProspectiveConfiguration(candidate, {
      coordinatorMode: "require-running",
      signal: input.signal,
    });
    return {
      credentialsRevision:
        (
          await readFeedCredentialPreview(
            input,
            administrativeConfigurationState(writer).connection,
          )
        ).row.credentialsRevision ?? patch.expectedCredentialsRevision,
      configuration: result.application,
    };
  });
}
