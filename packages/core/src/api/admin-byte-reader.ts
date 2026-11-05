/** Incremental byte consumption: callbacks and their cleanup stay inside request ownership. */
import { ApiRequestAbortedError } from "./client";
import { ApiContractError } from "./sdk-transport";
export interface AdminByteConsumer {
  onByteChunk: (chunk: Uint8Array, signal: AbortSignal) => void | Promise<void>;
  onByteHeaders?: (headers: Headers, signal: AbortSignal) => void | Promise<void>;
}
async function readOwned<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    signal.throwIfAborted();
  }
  let abort = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export async function consumeAdminBytes(
  response: Response,
  parent: AbortSignal,
  consumer: AdminByteConsumer,
): Promise<void> {
  if (!response.body) throw new ApiContractError(response.status);
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw new ApiContractError(response.status);
  const expected = length === null ? null : Number(length),
    controller = new AbortController(),
    signal = controller.signal;
  const cancel = () => controller.abort(parent.reason);
  if (parent.aborted) cancel();
  else parent.addEventListener("abort", cancel, { once: true });
  let idle: ReturnType<typeof setTimeout> | undefined,
    completed = false,
    bytes = 0;
  const touch = () => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new ApiRequestAbortedError("timeout")), 5 * 60_000);
  };
  const reader = response.body.getReader();
  try {
    touch();
    signal.throwIfAborted();
    await consumer.onByteHeaders?.(response.headers, signal);
    signal.throwIfAborted();
    touch();
    for (;;) {
      const { done, value } = await readOwned(reader.read(), signal);
      if (done) break;
      if (value.byteLength > 8 * 1024 * 1024) throw new ApiContractError(response.status);
      bytes += value.byteLength;
      if (!Number.isSafeInteger(bytes) || (expected !== null && bytes > expected))
        throw new ApiContractError(response.status);
      touch();
      // Never race an active sink with abort: it must settle its own cleanup first.
      await consumer.onByteChunk(value, signal);
      signal.throwIfAborted();
      touch();
    }
    signal.throwIfAborted();
    if (expected !== null && bytes !== expected) throw new ApiContractError(response.status);
    completed = true;
  } catch (error) {
    if (signal.aborted && !parent.aborted) throw new ApiRequestAbortedError("timeout");
    throw error;
  } finally {
    if (idle !== undefined) clearTimeout(idle);
    parent.removeEventListener("abort", cancel);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
