// @vitest-environment node
import { createApiClient } from "@openmapx/core";
import { streamAdminServiceLogs } from "@openmapx/core/api-admin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const client = createApiClient({ baseUrl: "http://admin.test" });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("actual generated log observation lifetime", () => {
  it.each(["throw", "reject", "hang-then-reject", "abort-inside-callback"])(
    "cancels/unlocks for %s without unhandled rejection or leaked timer",
    async (mode) => {
      vi.useFakeTimers();
      let canceled = 0;
      let entered!: () => void;
      let rejectCallback!: (reason: Error) => void;
      const entering = new Promise<void>((r) => {
        entered = r;
      });
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("chunk"));
        },
        cancel() {
          canceled++;
        },
      });
      vi.stubGlobal(
        "fetch",
        async () => new Response(body, { headers: { "content-type": "text/plain" } }),
      );
      const caller = new AbortController();
      const result = streamAdminServiceLogs(
        "synthetic",
        { "idempotency-key": "synthetic-log-intent-1" },
        undefined,
        {
          client,
          signal: caller.signal,
          timeoutMs: 60_000,
          onTextChunk: () => {
            entered();
            if (mode === "throw") throw new Error("synthetic-callback");
            if (mode === "reject") return Promise.reject(new Error("synthetic-callback"));
            if (mode === "abort-inside-callback") {
              caller.abort();
              return Promise.reject(new Error("late-callback"));
            }
            return new Promise<void>((_resolve, reject) => {
              rejectCallback = reject;
            });
          },
        },
      );
      const rejected = expect(result).rejects.toThrow();
      await entering;
      if (mode === "hang-then-reject") caller.abort();
      await rejected;
      if (mode === "hang-then-reject") rejectCallback(new Error("late-callback"));
      await vi.advanceTimersByTimeAsync(0);
      expect(canceled).toBe(1);
      expect(body.locked).toBe(false);
      expect((vi as typeof vi & { getTimerCount(): number }).getTimerCount()).toBe(0);
    },
  );
  it("returns undefined success data after transport UTF8 EOF flush", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([0xe2]));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      async () => new Response(body, { headers: { "content-type": "text/plain" } }),
    );
    const chunks: string[] = [];
    const result = await streamAdminServiceLogs(
      "synthetic",
      { "idempotency-key": "synthetic-log-intent-1" },
      undefined,
      {
        client,
        onTextChunk: (chunk) => {
          chunks.push(chunk);
        },
      },
    );
    expect(result.status).toBe(200);
    expect(result.data).toBeUndefined();
    expect(chunks).toEqual(["�"]);
    expect(body.locked).toBe(false);
  });
});
