import { type ApiClient, ApiNativeDownloadUnavailableError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
export interface PrivacyDownloadSink {
  write(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}
export async function consumePrivacyDownload(input: {
  kind: "attachment" | "artifact";
  requestId: string;
  itemId: string;
  client: ApiClient;
  sink: PrivacyDownloadSink;
  signal: AbortSignal;
}): Promise<void> {
  let aborting: Promise<void> | undefined;
  const abort = (reason: unknown) =>
    (aborting ??= Promise.resolve().then(() => input.sink.abort(reason)));
  const onAbort = () => {
    void abort(input.signal.reason).catch(() => undefined);
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    input.signal.throwIfAborted();
    const operation =
      input.kind === "attachment"
        ? sdk.downloadPrivacyAdminAttachment
        : sdk.downloadPrivacyAdminArtifact;
    const result = await operation(input.requestId, input.itemId, {
      client: input.client,
      signal: input.signal,
      timeoutMs: 180000,
      onByteChunk: async (chunk, signal) => {
        const cancel = () => {
          void abort(signal.reason).catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          signal.throwIfAborted();
          await input.sink.write(chunk, signal);
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", cancel);
          if (aborting) await aborting.catch(() => undefined);
        }
      },
    });
    sdk.unwrapAdminResponse(result);
    input.signal.throwIfAborted();
    await input.sink.close();
  } catch (error) {
    try {
      await abort(error);
    } catch {
      /* Retain the original request/write failure. */
    }
    throw error;
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (aborting) await aborting.catch(() => undefined);
  }
}
type Writable = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};
type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<{ createWritable(): Promise<Writable> }>;
};
export function privacyFileSinkSupported() {
  return (
    typeof window !== "undefined" &&
    typeof (window as PickerWindow).showSaveFilePicker === "function"
  );
}
/** Call from an explicit click, before consuming a one-use download challenge. */
export async function createPrivacyFileSink(filename: string): Promise<PrivacyDownloadSink> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (!picker) throw new ApiNativeDownloadUnavailableError("runtime");
  const handle = await picker.call(window, { suggestedName: filename });
  const writable = await handle.createWritable();
  let pending: Promise<void> | undefined,
    aborting: Promise<void> | undefined,
    closed = false;
  const abort = async (reason: unknown) => {
    if (closed) return;
    closed = true;
    aborting ??= Promise.resolve().then(() => writable.abort(reason));
    const results = await Promise.allSettled([pending, aborting]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  return {
    async write(chunk, signal) {
      if (closed) throw Error("Download sink closed");
      signal.throwIfAborted();
      const onAbort = () => {
        void abort(signal.reason).catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        pending = writable.write(chunk);
        await pending;
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (aborting) await aborting.catch(() => undefined);
      }
    },
    async close() {
      if (closed) throw Error("Download sink closed");
      await pending;
      await writable.close();
      closed = true;
    },
    abort,
  };
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
    if (privacyFileSinkSupported()) return { kind: "sink" as const };
    return { kind: "unavailable" as const, reason: error.reason };
  }
}
