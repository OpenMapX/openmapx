import { getDataManagerStreamContext } from "./transport";

export interface DataManagerStreamLimits {
  maxBytes?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}
type Event = { event: "progress" | "done" | "error"; message?: string };
/** Strict bounded NDJSON decoding; the authoritative schema owns each event's fields. */
export async function readDataManagerNdjson<E extends Event>(
  response: Response,
  schema: { parse(input: unknown): E },
  onProgress?: (event: Extract<E, { event: "progress" }>) => void,
  limits: DataManagerStreamLimits = {},
): Promise<Extract<E, { event: "done" }>> {
  if (!response.ok || !response.body)
    throw new Error(`Data-manager NDJSON stream unavailable (HTTP ${response.status})`);
  const inherited = getDataManagerStreamContext(response);
  const maxBytes = limits.maxBytes ?? inherited?.maxBytes ?? 8 * 1024 * 1024;
  const idleTimeoutMs = limits.idleTimeoutMs ?? inherited?.idleTimeoutMs ?? 5 * 60_000;
  const signals = [limits.signal, inherited?.signal].filter((value): value is AbortSignal =>
    Boolean(value),
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let terminal: Extract<E, { event: "done" }> | undefined;
  let ended = false;
  function line(value: string): void {
    if (!value.trim()) return;
    if (terminal) throw new Error("Data-manager NDJSON record after terminal event");
    let parsed: E;
    try {
      parsed = schema.parse(JSON.parse(value));
    } catch {
      throw new Error("Data-manager NDJSON event contract failed");
    }
    if (parsed.event === "error")
      throw new Error(parsed.message ?? "Data-manager operation failed");
    if (parsed.event === "done") terminal = parsed as Extract<E, { event: "done" }>;
    else onProgress?.(parsed as Extract<E, { event: "progress" }>);
  }
  try {
    if (
      !Number.isFinite(maxBytes) ||
      maxBytes <= 0 ||
      !Number.isFinite(idleTimeoutMs) ||
      idleTimeoutMs <= 0
    )
      throw new Error("Data-manager stream limits must be positive finite numbers");
    for (;;) {
      signal?.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Data-manager NDJSON stream idle timeout")),
              idleTimeoutMs,
            );
            if (signal) {
              abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && abort) signal.removeEventListener("abort", abort);
      }
      if (next.done) {
        ended = true;
        buffer += decoder.decode();
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > maxBytes)
        throw new Error(`Data-manager NDJSON response too large (exceeded ${maxBytes} bytes)`);
      buffer += decoder.decode(next.value, { stream: true });
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
    line(buffer);
    if (!terminal) throw new Error("Data-manager stream ended without a 'done' event");
    return terminal;
  } catch (error) {
    if (!ended) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reader.cancel().catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 250);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
