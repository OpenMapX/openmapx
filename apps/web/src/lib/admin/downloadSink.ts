import { ApiNativeDownloadUnavailableError } from "@openmapx/core";

export interface DownloadSink {
  write(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
type ByteConsumer = (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;

/** Feature callers retain their generated operation, credentials and deadline. */
export async function consumeDownloadToSink(
  { sink, signal }: { sink: DownloadSink; signal: AbortSignal },
  consume: (onByteChunk: ByteConsumer) => Promise<void>,
): Promise<void> {
  let aborting: Promise<void> | undefined;
  const abort = (reason: unknown) =>
    (aborting ??= Promise.resolve().then(() => sink.abort(reason)));
  const onAbort = () => {
    void abort(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    await consume(async (chunk, effectiveSignal) => {
      const cancel = () => {
        void abort(effectiveSignal.reason).catch(() => undefined);
      };
      effectiveSignal.addEventListener("abort", cancel, { once: true });
      try {
        effectiveSignal.throwIfAborted();
        await sink.write(chunk, effectiveSignal);
        effectiveSignal.throwIfAborted();
      } finally {
        effectiveSignal.removeEventListener("abort", cancel);
        if (aborting) await aborting.catch(() => undefined);
      }
    });
    signal.throwIfAborted();
    await sink.close();
  } catch (error) {
    await abort(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (aborting) await aborting.catch(() => undefined);
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
export function fileSinkSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as PickerWindow).showSaveFilePicker === "function"
  );
}
/** Call in the user gesture, before acquiring bytes or consuming one-use authority. */
export async function createFileSink(filename: string): Promise<DownloadSink> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (!picker) throw new ApiNativeDownloadUnavailableError("runtime");
  const handle = await picker.call(window, { suggestedName: filename }),
    writable = await handle.createWritable();
  let closed = false,
    pending: Promise<void> | undefined,
    aborting: Promise<void> | undefined;
  const abort = async (reason?: unknown) => {
    if (!closed) {
      closed = true;
      aborting = Promise.resolve().then(() => writable.abort(reason));
    }
    const results = await Promise.allSettled([pending, aborting]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  return {
    async write(chunk, signal) {
      if (closed) throw Error("Download sink is closed");
      signal.throwIfAborted();
      const cancel = () => {
        void abort(signal.reason).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        pending = writable.write(chunk);
        await pending;
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", cancel);
        if (aborting) await aborting.catch(() => undefined);
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
