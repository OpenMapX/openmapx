/** Fixed platform producer, sharing the original administrative job and writer.
 * Purpose proofs are transient until encrypted inside the bounded candidate. */

import { getAllIntegrations } from "../integration-host";
import { executeAdminJobOperation } from "./admin-job-ops";
import {
  currentAdministrativeConfigurationWriter,
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer-owner";
import { withConfigurationCommitParticipant } from "./configuration-commit-participant";
import type { JobContext } from "./job-runner";
import type { PlatformConfigurationCommitInput } from "./platform-configuration";
import {
  platformConfigurationParticipation,
  preparePlatformConfigurationChange,
} from "./platform-configuration-participant";
import { readPlatformPreview } from "./platform-preview-store";
import {
  persistAndApplyProspectiveConfiguration,
  prepareProspectiveConfiguration,
} from "./prospective-configuration";

export type PlatformConfigurationApplicationInput = Pick<
  PlatformConfigurationCommitInput,
  "actorId" | "previewFingerprint" | "expectedCurrentRevisionId" | "confirmations" | "proof"
> & { operationKey: string };

export async function applyPlatformConfigurationIntent(
  input: PlatformConfigurationApplicationInput,
) {
  const writer = currentAdministrativeConfigurationWriter();
  if (writer.actorId !== input.actorId || writer.operationKey !== input.operationKey)
    throw Error("Platform configuration owner changed");
  const intent = await preparePlatformConfigurationChange(input, writer),
    scope = platformConfigurationParticipation(intent, writer);
  return withConfigurationCommitParticipant(writer, scope.participant, async () => {
    const candidate = await prepareProspectiveConfiguration({
      actorId: input.actorId,
      operationKey: input.operationKey,
      expectedCurrentRevisionId: input.expectedCurrentRevisionId,
      overlay: scope.overlay,
    });
    return persistAndApplyProspectiveConfiguration(candidate, {
      coordinatorMode: "require-running",
    });
  });
}
export async function runPlatformConfigurationChange(
  ctx: JobContext,
  input: PlatformConfigurationApplicationInput,
) {
  // A release selection is downloaded before anything is committed, so a
  // registry outage fails the change while every service still runs as before.
  if (!ctx.checkpointResult?._configurationCandidate) {
    const { preview } = await readPlatformPreview({
      actorId: input.actorId,
      previewFingerprint: input.previewFingerprint,
    });
    if (preview.release)
      await executeAdminJobOperation(
        ctx,
        {
          kind: "release.images.pull",
          releaseId: preview.release.releaseId,
          manifestDigest: preview.release.manifestDigest,
        },
        "admin-job.release.images",
      );
  }
  return withAdministrativeConfigurationJob(ctx, () =>
    withAdministrativeConfigurationWriter(
      {
        actorId: input.actorId,
        operationKey: input.operationKey,
        signal: ctx.signal,
        integrationIds: getAllIntegrations().map((integration) => integration.id),
      },
      () => applyPlatformConfigurationIntent(input),
    ),
  );
}
