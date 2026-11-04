import type { ApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { TransferStage } from "@openmapx/core/ops";

import { consumeDownloadToSink, createFileSink, type DownloadSink } from "./downloadSink";

export type { DownloadSink as ArtifactDownloadSink } from "./downloadSink";
export { fileSinkSupported as artifactFileSinkSupported } from "./downloadSink";

const STREAM_TIMEOUT = 72 * 3600_000;
function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
/** The File remains a native request body. Inspection is observation, never an
 * automatic replay of an upload whose response was lost. */
export async function uploadArtifactFile(input: {
  client: ApiClient;
  stageId: string;
  file: File;
  signal: AbortSignal;
  onProgress?: (progress: { receivedBytes: number; state: TransferStage["state"] }) => void;
}): Promise<TransferStage> {
  input.signal.throwIfAborted();
  const observer = new AbortController(),
    signal = AbortSignal.any([input.signal, observer.signal]);
  const progress = (stage: TransferStage) =>
    input.onProgress?.({ receivedBytes: stage.bytes, state: stage.state });
  const observing = (async () => {
    while (!signal.aborted) {
      try {
        const stage = sdk.unwrapAdminResponse(
          await sdk.getAdminArtifactTransfer(input.stageId, { client: input.client, signal }),
        );
        if (!signal.aborted) progress(stage);
      } catch {
        if (signal.aborted) return;
      }
      try {
        await wait(signal);
      } catch {
        return;
      }
    }
  })();
  try {
    let stage: TransferStage;
    try {
      stage = sdk.unwrapAdminResponse(
        await sdk.uploadAdminArtifactTransferContent(input.stageId, input.file, {
          client: input.client,
          signal: input.signal,
          timeoutMs: STREAM_TIMEOUT,
        }),
      );
    } catch (error) {
      input.signal.throwIfAborted();
      const retained = sdk.unwrapAdminResponse(
        await sdk.getAdminArtifactTransfer(input.stageId, {
          client: input.client,
          signal: input.signal,
        }),
      );
      if (
        !["uploaded", "ready", "claimed", "consumed"].includes(retained.state) ||
        retained.bytes !== input.file.size ||
        !retained.sha256
      )
        throw error;
      stage = retained;
    }
    input.signal.throwIfAborted();
    progress(stage);
    return stage;
  } finally {
    observer.abort();
    await observing;
  }
}

export async function downloadArtifactToSink(input: {
  client: ApiClient;
  stageId: string;
  sink: DownloadSink;
  signal: AbortSignal;
}): Promise<void> {
  return consumeDownloadToSink(input, async (onByteChunk) => {
    sdk.unwrapAdminResponse(
      await sdk.downloadAdminArtifactTransferContent(input.stageId, {
        client: input.client,
        signal: input.signal,
        timeoutMs: STREAM_TIMEOUT,
        onByteChunk,
      }),
    );
  });
}
export function createArtifactFileSink(): Promise<DownloadSink> {
  return createFileSink("openmapx-artifact.tar");
}
