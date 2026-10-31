import {
  withAdministrativeConfigurationJob,
  withAdministrativeConfigurationWriter,
} from "./administrative-configuration-writer-owner";
import type { JobContext } from "./job-runner";
import { readTransitCredentialAuthorization } from "./transit-credential-authorization";
import type { FeedCredentialApplyResult } from "./transit-feed-credentials";
import {
  applyFeedCredentialChanges,
  withTransitCredentialProofContext,
} from "./transit-feed-credentials";
export async function runTransitCredentialChange(
  ctx: JobContext,
  input: { actorId: string; previewId: string; intentFingerprint: string; operationKey: string },
): Promise<FeedCredentialApplyResult> {
  const binding = await readTransitCredentialAuthorization(input);
  return withTransitCredentialProofContext(
    {
      actorId: binding.actorId,
      sessionId: binding.sessionId,
      nonce: Buffer.from(binding.nonce, "base64url"),
    },
    () =>
      withAdministrativeConfigurationJob(ctx, () =>
        withAdministrativeConfigurationWriter(
          {
            actorId: input.actorId,
            operationKey: input.operationKey,
            integrationIds: [],
            signal: ctx.signal,
          },
          () =>
            applyFeedCredentialChanges({
              ...input,
              authorization: { kind: "direct", transitProofToken: binding.transitProofToken },
              signal: ctx.signal,
            }),
        ),
      ),
  );
}
