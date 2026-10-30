import { type ApiClient, ApiNativeDownloadUnavailableError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { TransferStage } from "@openmapx/core/ops";

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

export interface ArtifactDownloadSink {
  write(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
export async function downloadArtifactToSink(input: {
  client: ApiClient;
  stageId: string;
  sink: ArtifactDownloadSink;
  signal: AbortSignal;
}): Promise<void> {
  let aborting: Promise<void> | undefined;
  const abort = (reason: unknown) =>
    (aborting ??= Promise.resolve().then(() => input.sink.abort(reason)));
  const onAbort = () => {
    void abort(input.signal.reason).catch(() => {});
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    input.signal.throwIfAborted();
    sdk.unwrapAdminResponse(
      await sdk.downloadAdminArtifactTransferContent(input.stageId, {
        client: input.client,
        signal: input.signal,
        timeoutMs: STREAM_TIMEOUT,
        onByteChunk: async (chunk, signal) => {
          const cancel = () => {
            void abort(signal.reason).catch(() => {});
          };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            signal.throwIfAborted();
            await input.sink.write(chunk, signal);
            signal.throwIfAborted();
          } finally {
            signal.removeEventListener("abort", cancel);
            if (aborting) await aborting.catch(() => {});
          }
        },
      }),
    );
    input.signal.throwIfAborted();
    await input.sink.close();
  } catch (error) {
    await abort(error).catch(() => {});
    throw error;
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (aborting) await aborting.catch(() => {});
  }
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    createWritable(): Promise<{
      write(chunk: Uint8Array): Promise<void>;
      close(): Promise<void>;
      abort(reason?: unknown): Promise<void>;
    }>;
  }>;
};
export function artifactFileSinkSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as PickerWindow).showSaveFilePicker === "function"
  );
}
/** Invoke directly in the user gesture, before awaiting a network request. */
export async function createArtifactFileSink(): Promise<ArtifactDownloadSink> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (!picker) throw new ApiNativeDownloadUnavailableError("runtime");
  const handle = await picker.call(window, { suggestedName: "openmapx-artifact.tar" }),
    writable = await handle.createWritable();
  let closed = false,
    pending: Promise<void> | undefined,
    aborting: Promise<void> | undefined;
  const abort = async (reason?: unknown) => {
    if (closed) {
      if (aborting) await aborting;
      return;
    }
    closed = true;
    aborting = Promise.resolve().then(() => writable.abort(reason));
    const results = await Promise.allSettled([pending, aborting]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  return {
    async write(chunk, signal) {
      if (closed) throw Error("Download sink is closed");
      signal.throwIfAborted();
      const cancel = () => {
        void abort(signal.reason).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        pending = writable.write(chunk);
        await pending;
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", cancel);
        if (aborting) await aborting.catch(() => {});
      }
    },
    async close() {
      if (closed) throw Error("Download sink is closed");
      await pending;
      await writable.close();
      closed = true;
    },
    abort,
  };
}
