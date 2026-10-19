import type { ResponseOptions } from "@openmapx/integration-framework";

/** Cancellation is initiated immediately, without letting upstream cleanup stall a deadline. */
function discard(body: ReadableStream<Uint8Array> | null, reason: unknown): void {
  void body?.cancel(reason).catch(() => {});
}

/**
 * A pull-driven byte ceiling shared by text, binary and streaming host clients.
 * Owning the reader also lets cancellation terminate a body even if it stalls
 * after headers, or a consumer never starts reading it.
 */
export function boundedIntegrationResponseStream(
  response: Response,
  options: ResponseOptions,
  signal: AbortSignal,
  allowErrorContentType = false,
): ReadableStream<Uint8Array> {
  try {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new Error("integration HTTP response maxBytes must be a positive safe integer");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      throw new Error("integration HTTP response too large (declared length exceeds maxBytes)");
    }
    if (response.ok || !allowErrorContentType) {
      const mediaType = (
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() ??
        options.fallbackContentType
      )?.toLowerCase();
      if (
        !mediaType ||
        !options.contentTypes.some((allowed) => allowed.toLowerCase() === mediaType)
      ) {
        throw new Error("integration HTTP response has unexpected content type");
      }
    }
  } catch (error) {
    discard(response.body, error);
    throw error;
  }

  if (!response.body) return new ReadableStream({ start: (controller) => controller.close() });
  const reader = response.body.getReader();
  let finished = false;
  let total = 0;
  let abort: () => void;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const cancel = (reason: unknown) => {
    finished = true;
    cleanup();
    // read() settles when canceled, even if the source's cancel hook never does.
    void reader.cancel(reason).catch(() => {});
    reader.releaseLock();
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          if (finished) return;
          controller.error(signal.reason);
          cancel(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (finished) return;
          if (done) {
            finished = true;
            cleanup();
            reader.releaseLock();
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > options.maxBytes) {
            throw new Error("integration HTTP response too large (stream exceeds maxBytes)");
          }
          controller.enqueue(value);
        } catch (error) {
          if (finished) return;
          controller.error(error);
          cancel(error);
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
}

export async function bufferIntegrationResponse(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
