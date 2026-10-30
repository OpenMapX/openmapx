import { createApiClient } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASE_A, CASE_B } from "@/components/admin/privacy/privacyFixtures.test-support";
import {
  consumePrivacyDownload,
  createPrivacyFileSink,
  privacyDownloadCapability,
} from "./privacyDownload";

const headers = {
  "content-type": "application/octet-stream",
  "content-disposition": 'attachment; filename="evidence.bin"',
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
afterEach(() => vi.unstubAllGlobals());
describe("privacy byte downloads", () => {
  it("retains the provided client and writes non-UTF8 bytes before closing", async () => {
    const received: Uint8Array[] = [];
    let closed = false;
    const request = vi.fn(
      async (_input: unknown, _init?: unknown) =>
        new Response(new Uint8Array([0, 255, 128, 14]), { headers }),
    );
    vi.stubGlobal("fetch", request);
    await consumePrivacyDownload({
      kind: "attachment",
      requestId: CASE_A,
      itemId: CASE_B,
      client: createApiClient({
        baseUrl: "http://privacy.test",
        credentials: "omit",
        headerInterceptor: () => ({ "x-synthetic-client": "bound" }),
      }),
      signal: new AbortController().signal,
      sink: {
        write: async (bytes) => {
          received.push(bytes);
        },
        close: async () => {
          closed = true;
        },
        abort: async () => {
          throw Error("unexpected abort");
        },
      },
    });
    expect([...received[0]!]).toEqual([0, 255, 128, 14]);
    expect(closed).toBe(true);
    const first = request.mock.calls[0];
    if (!first || !first[1]) throw Error("Missing generated request fixture");
    expect(String(first[0])).toContain("http://privacy.test");
    expect(new Headers((first[1] as RequestInit).headers).get("x-synthetic-client")).toBe("bound");
    expect((first[1] as RequestInit).credentials).toBe("omit");
  });
  it("awaits sink abort cleanup when canceled during a blocked write", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const writing = new Promise<void>((r) => {
      entered = r;
    });
    let settleWrite!: () => void;
    const pending = new Promise<void>((r) => {
      settleWrite = r;
    });
    let abortFinished = false,
      closed = false;
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3]), { headers }));
    const download = consumePrivacyDownload({
      kind: "artifact",
      requestId: CASE_A,
      itemId: CASE_B,
      client: createApiClient({ baseUrl: "http://privacy.test" }),
      signal: controller.signal,
      sink: {
        write: async () => {
          entered();
          await pending;
        },
        close: async () => {
          closed = true;
        },
        abort: async () => {
          settleWrite();
          await Promise.resolve();
          abortFinished = true;
        },
      },
    });
    await writing;
    controller.abort(new DOMException("case switched", "AbortError"));
    await expect(download).rejects.toThrow();
    expect(abortFinished).toBe(true);
    expect(closed).toBe(false);
  });
  it("refuses alternate-origin or omit native targets without an available sink before any GET", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const capability = await privacyDownloadCapability(
      "artifact",
      CASE_A,
      CASE_B,
      createApiClient({ baseUrl: "http://different.test", credentials: "omit" }),
    );
    expect(capability.kind).toBe("unavailable");
    expect(request).not.toHaveBeenCalled();
  });
  it("file sink abort settles both the blocked writable and its abort promise", async () => {
    let release!: () => void;
    let aborted = false;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: async () => ({
        createWritable: async () => ({
          write: async () => pending,
          close: async () => undefined,
          abort: async () => {
            release();
            aborted = true;
          },
        }),
      }),
    });
    try {
      const sink = await createPrivacyFileSink("safe.zip");
      const controller = new AbortController();
      const write = sink.write(new Uint8Array([7]), controller.signal);
      controller.abort();
      await expect(write).rejects.toThrow();
      expect(aborted).toBe(true);
    } finally {
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    }
  });
  it("aborts a blocked sink on the generated request deadline after headers", async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const writing = new Promise<void>((r) => {
      entered = r;
    });
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let aborted = false;
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([9]), { headers }));
    const download = consumePrivacyDownload({
      kind: "artifact",
      requestId: CASE_A,
      itemId: CASE_B,
      client: createApiClient({ baseUrl: "http://privacy.test" }),
      signal: new AbortController().signal,
      sink: {
        write: async () => {
          entered();
          await blocked;
        },
        close: async () => undefined,
        abort: async () => {
          aborted = true;
          release();
        },
      },
    });
    const failure = download.catch(() => undefined);
    try {
      await writing;
      await vi.advanceTimersByTimeAsync(180001);
      expect(aborted).toBe(true);
    } finally {
      release();
      await failure;
      vi.useRealTimers();
    }
  });
});
