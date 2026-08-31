export interface StreamReadLimits {
  maxBytes: number;
  idleTimeoutMs: number;
}

export const DEFAULT_NDJSON_STREAM_LIMITS: Readonly<StreamReadLimits> = {
  maxBytes: 8 * 1024 * 1024,
  idleTimeoutMs: 5 * 60_000,
};

interface StreamResponse {
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
  status?: number;
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label}: stream idle timeout`)),
          idleTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function readBoundedNdjsonStream<Result>(
  response: StreamResponse,
  label: string,
  reduceEvent: (message: Record<string, unknown>) => Result | undefined,
  limits: StreamReadLimits = DEFAULT_NDJSON_STREAM_LIMITS,
): Promise<Result> {
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status ?? "?"}`);
  if (!response.body) throw new Error(`${label}: server returned no body stream`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseBytes = 0;
  let final: Result | undefined;
  let sawDone = false;
  let streamEnded = false;

  const handleLine = (line: string) => {
    const message = parseRecord(line);
    if (!message) return;
    if (message.event === "error") {
      throw new Error(String(message.message ?? `${label} failed`));
    }
    const result = reduceEvent(message);
    if (message.event === "done") {
      sawDone = true;
      if (result !== undefined) final = result;
    }
  };

  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, label, limits.idleTimeoutMs);
      if (done) {
        streamEnded = true;
        buffer += decoder.decode();
        break;
      }

      responseBytes += value.byteLength;
      if (responseBytes > limits.maxBytes) {
        throw new Error(`${label}: response too large (exceeded ${limits.maxBytes} bytes)`);
      }

      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) break;
        handleLine(buffer.slice(0, newlineIndex).trim());
        buffer = buffer.slice(newlineIndex + 1);
      }
    }

    handleLine(buffer.trim());
    if (!sawDone || final === undefined) {
      throw new Error(`${label}: stream ended without a 'done' event`);
    }
    return final;
  } catch (error) {
    if (!streamEnded) await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
