import { type ApiClient, ApiNativeDownloadUnavailableError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { consumeDownloadToSink, type DownloadSink, fileSinkSupported } from "./downloadSink";

export type { DownloadSink as PrivacyDownloadSink } from "./downloadSink";
export {
  createFileSink as createPrivacyFileSink,
  fileSinkSupported as privacyFileSinkSupported,
} from "./downloadSink";

export async function consumePrivacyDownload(input: {
  kind: "attachment" | "artifact";
  requestId: string;
  itemId: string;
  client: ApiClient;
  sink: DownloadSink;
  signal: AbortSignal;
}): Promise<void> {
  return consumeDownloadToSink(input, async (onByteChunk) => {
    const operation =
      input.kind === "attachment"
        ? sdk.downloadPrivacyAdminAttachment
        : sdk.downloadPrivacyAdminArtifact;
    sdk.unwrapAdminResponse(
      await operation(input.requestId, input.itemId, {
        client: input.client,
        signal: input.signal,
        timeoutMs: 180000,
        onByteChunk,
      }),
    );
  });
}
export async function privacyDownloadCapability(
  kind: "attachment" | "artifact",
  requestId: string,
  itemId: string,
  client: ApiClient,
) {
  try {
    const target = await (kind === "artifact"
      ? sdk.getDownloadPrivacyAdminArtifactTarget
      : sdk.getDownloadPrivacyAdminAttachmentTarget)(requestId, itemId, { client });
    return { kind: "native" as const, target };
  } catch (error) {
    if (!(error instanceof ApiNativeDownloadUnavailableError)) throw error;
    if (fileSinkSupported()) return { kind: "sink" as const };
    return { kind: "unavailable" as const, reason: error.reason };
  }
}
