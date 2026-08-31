import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoundedNdjsonStream } from "../bounded-ndjson";

const encoder = new TextEncoder();
const LIMITS = { maxBytes: 4_096, idleTimeoutMs: 100 };

function responseFromChunks(chunks: Uint8Array[]): {
  ok: boolean;
  body: ReadableStream<Uint8Array>;
  status: number;
} {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

async function collectMessages(chunks: Uint8Array[]) {
  const progress: string[] = [];
  const result = await readBoundedNdjsonStream(
    responseFromChunks(chunks),
    "test/stream",
    (message) => {
      if (message.event === "progress") progress.push(String(message.message));
      if (message.event === "done") return String(message.value);
      return undefined;
    },
    LIMITS,
  );
  return { progress, result };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readBoundedNdjsonStream", () => {
  it("parses a JSON record split across chunks", async () => {
    const first = encoder.encode('{"event":"progress","message":"par');
    const second = encoder.encode('tial"}\n{"event":"done","value":"ok"}\n');

    await expect(collectMessages([first, second])).resolves.toEqual({
      progress: ["partial"],
      result: "ok",
    });
  });

  it("parses several records from one chunk and a terminal line without a newline", async () => {
    const content = [
      '{"event":"progress","message":"one"}',
      '{"event":"progress","message":"two"}',
      '{"event":"done","value":"complete"}',
    ].join("\n");

    await expect(collectMessages([encoder.encode(content)])).resolves.toEqual({
      progress: ["one", "two"],
      result: "complete",
    });
  });

  it("ignores malformed and non-object records", async () => {
    const content = [
      "not-json",
      "null",
      "[]",
      '{"event":"progress","message":"valid"}',
      '{"event":"done","value":"complete"}',
    ].join("\n");

    await expect(collectMessages([encoder.encode(content)])).resolves.toEqual({
      progress: ["valid"],
      result: "complete",
    });
  });

  it("preserves UTF-8 characters split inside a multibyte sequence", async () => {
    const content = encoder.encode(
      '{"event":"progress","message":"Grüße 🚲"}\n{"event":"done","value":"fertig"}\n',
    );
    const bicycleStart = content.indexOf(0xf0);

    await expect(
      collectMessages([content.slice(0, bicycleStart + 2), content.slice(bicycleStart + 2)]),
    ).resolves.toEqual({ progress: ["Grüße 🚲"], result: "fertig" });
  });

  it("rejects an idle stream and cancels its reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({ cancel }),
    };
    const result = readBoundedNdjsonStream(response, "idle", () => undefined, {
      maxBytes: 100,
      idleTimeoutMs: 10,
    });
    const rejection = expect(result).rejects.toThrow("idle: stream idle timeout");

    await vi.advanceTimersByTimeAsync(11);

    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces the byte limit and cancels its reader", async () => {
    const cancel = vi.fn();
    const response = {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("12345"));
        },
        cancel,
      }),
    };

    const result = readBoundedNdjsonStream(response, "large", () => undefined, {
      maxBytes: 4,
      idleTimeoutMs: 100,
    });

    await expect(result).rejects.toThrow("large: response too large (exceeded 4 bytes)");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("surfaces server errors and cancels the open reader", async () => {
    const cancel = vi.fn();
    const response = {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"event":"error","message":"upstream failed"}\n'));
        },
        cancel,
      }),
    };

    const result = readBoundedNdjsonStream(response, "operation", () => undefined, LIMITS);

    await expect(result).rejects.toThrow("upstream failed");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("requires a terminal done event", async () => {
    const response = responseFromChunks([
      encoder.encode('{"event":"progress","message":"still working"}\n'),
    ]);

    await expect(
      readBoundedNdjsonStream(response, "unfinished", () => "premature", LIMITS),
    ).rejects.toThrow("unfinished: stream ended without a 'done' event");
  });

  it("rejects unsuccessful and bodyless responses before reading", async () => {
    await expect(
      readBoundedNdjsonStream(
        { ok: false, status: 503, body: null },
        "failed",
        () => undefined,
        LIMITS,
      ),
    ).rejects.toThrow("failed failed: HTTP 503");
    await expect(
      readBoundedNdjsonStream(
        { ok: true, status: 200, body: null },
        "empty",
        () => undefined,
        LIMITS,
      ),
    ).rejects.toThrow("empty: server returned no body stream");
  });
});
