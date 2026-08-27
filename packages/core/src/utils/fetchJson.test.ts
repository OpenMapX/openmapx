import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "./fetchJson";
import { USER_AGENT } from "./userAgent";

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredResponse(): {
  promise: Promise<Response>;
  reject: (reason: unknown) => void;
  resolve: (response: Response) => void;
} {
  let reject!: (reason: unknown) => void;
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  it("returns parsed JSON on a 2xx response", async () => {
    mockFetch(() => jsonResponse({ ok: true, n: 42 }));
    const data = await fetchJson<{ ok: boolean; n: number }>("https://x.test/data");
    expect(data).toEqual({ ok: true, n: 42 });
  });

  it("rejects a response whose declared length exceeds maxBytes before parsing", async () => {
    const json = vi.fn(async () => ({ ok: true }));
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": "100" }),
          body: new Response("{}").body,
          json,
        }) as unknown as Response,
    );
    await expect(fetchJson("https://x.test/data", { maxBytes: 10 })).rejects.toThrow(/too large/i);
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects a streamed response that exceeds maxBytes", async () => {
    mockFetch(
      () => new Response("x".repeat(100), { headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchJson("https://x.test/data", { maxBytes: 10 })).rejects.toThrow(/too large/i);
  });

  it("bounds cancellation when an oversized response reader never settles", async () => {
    vi.useFakeTimers();
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(20) }),
      cancel: vi.fn(async () => await new Promise<void>(() => {})),
      releaseLock: vi.fn(),
    };
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          body: { getReader: () => reader },
        }) as unknown as Response,
    );
    let outcome = "pending";
    let caught: Error | undefined;
    const operation = fetchJson("https://x.test/data", { maxBytes: 10, timeoutMs: 30 }).catch(
      (error) => {
        caught = error as Error;
        outcome = "rejected";
      },
    );

    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;
    expect(outcome).toBe("rejected");
    expect(caught?.message).toMatch(/too large/i);
    expect(reader.read).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a response reader and its cancellation when both ignore request abort", async () => {
    vi.useFakeTimers();
    const cancellationStarted = deferred();
    const reader = {
      read: vi.fn(async () => await new Promise<never>(() => {})),
      cancel: vi.fn(async () => {
        cancellationStarted.resolve();
        return await new Promise<void>(() => {});
      }),
      releaseLock: vi.fn(),
    };
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          body: { getReader: () => reader },
        }) as unknown as Response,
    );
    let outcome = "pending";
    const operation = fetchJson("https://x.test/data", { timeoutMs: 30 }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    await vi.advanceTimersByTimeAsync(30);
    await cancellationStarted.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;
    expect(outcome).toBe("rejected");
    expect(reader.read).toHaveBeenCalledOnce();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed without invoking a never-settling bodyless JSON provider", async () => {
    vi.useFakeTimers();
    const json = vi.fn(async () => await new Promise<never>(() => {}));
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          body: null,
          json,
        }) as unknown as Response,
    );
    let outcome = "pending";
    let caught: Error | undefined;
    const operation = fetchJson("https://x.test/bodyless", { timeoutMs: 30 }).catch((error) => {
      caught = error as Error;
      outcome = "rejected";
    });

    await vi.advanceTimersByTimeAsync(30);

    expect(outcome).toBe("rejected");
    expect(caught?.message).toMatch(/stream-readable/i);
    expect(json).not.toHaveBeenCalled();
    await operation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed before materializing an oversized bodyless JSON provider", async () => {
    const json = vi.fn(async () => ({ payload: "x".repeat(10_000) }));
    mockFetch(
      () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "application/json" }),
          body: null,
          json,
        }) as unknown as Response,
    );

    await expect(fetchJson("https://x.test/bodyless", { maxBytes: 10 })).rejects.toThrow(
      /stream-readable/i,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects a successful non-JSON media type", async () => {
    mockFetch(
      () => new Response("<html>not json</html>", { headers: { "Content-Type": "text/html" } }),
    );
    await expect(fetchJson("https://x.test/data")).rejects.toThrow(/content type/i);
  });

  it("honours an operator-raised OPENMAPX_FETCH_JSON_MAX_BYTES ceiling with a one-time warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.OPENMAPX_FETCH_JSON_MAX_BYTES = String(64 * 1024 * 1024);
    try {
      const big = `{"items":"${"x".repeat(9 * 1024 * 1024)}"}`;
      mockFetch(() => new Response(big, { headers: { "Content-Type": "application/json" } }));
      await expect(fetchJson("https://x.test/data")).resolves.toBeTruthy();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.OPENMAPX_FETCH_JSON_MAX_BYTES;
      warn.mockRestore();
    }
  });

  it("accepts JSON served as text/plain by raw-file hosts", async () => {
    mockFetch(
      () =>
        new Response('{"ok":true}', {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    );
    await expect(
      fetchJson("https://raw.githubusercontent.com/org/repo/main/data.json"),
    ).resolves.toEqual({ ok: true });
  });

  it("sends the shared User-Agent and merges extra headers", async () => {
    const fn = mockFetch(() => jsonResponse({}));
    await fetchJson("https://x.test/data", { headers: { "Accept-Language": "de" } });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    expect((init.headers as Record<string, string>)["Accept-Language"]).toBe("de");
  });

  it("omits the User-Agent when userAgent is null", async () => {
    const fn = mockFetch(() => jsonResponse({}));
    await fetchJson("https://x.test/data", { userAgent: null });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeUndefined();
  });

  it("throws with the label on a non-2xx response", async () => {
    mockFetch(() => jsonResponse({ error: "boom" }, 503));
    await expect(fetchJson("https://x.test/data", { label: "Acme" })).rejects.toThrow(
      "Acme HTTP 503",
    );
  });

  it("uses a custom errorMessage builder on a non-2xx response", async () => {
    mockFetch(
      () => new Response('{"message":"missing"}', { status: 404, statusText: "Not Found" }),
    );
    await expect(
      fetchJson("https://x.test/data", {
        errorMessage: ({ status, statusText, body }) =>
          `RIS failed: ${status} ${statusText}: ${body}`,
      }),
    ).rejects.toThrow('RIS failed: 404 Not Found: {"message":"missing"}');
  });

  it("reads at most a bounded prefix from an oversized error body", async () => {
    let observedBody = "";
    mockFetch(() => new Response("x".repeat(10_000), { status: 502 }));
    await expect(
      fetchJson("https://x.test/data", {
        errorMessage: ({ body }) => {
          observedBody = body ?? "";
          return "bounded error";
        },
      }),
    ).rejects.toThrow("bounded error");
    expect(new TextEncoder().encode(observedBody)).toHaveLength(1_024);
  });

  it("keeps custom errors working with minimal response doubles", async () => {
    mockFetch(
      () => ({ ok: false, status: 503, statusText: "Service Unavailable" }) as unknown as Response,
    );
    await expect(
      fetchJson("https://x.test/data", {
        errorMessage: ({ status, body }) => `upstream ${status}${body ? `: ${body}` : ""}`,
      }),
    ).rejects.toThrow("upstream 503");
  });

  it("returns null on a non-2xx response when nullOnError is set", async () => {
    mockFetch(() => jsonResponse({}, 500));
    const data = await fetchJson("https://x.test/data", { nullOnError: true });
    expect(data).toBeNull();
  });

  it("returns null on a network error when nullOnError is set", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    const data = await fetchJson("https://x.test/data", { nullOnError: true });
    expect(data).toBeNull();
  });

  it("forwards caller cancellation and does not hide it behind nullOnError", async () => {
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const work = fetchJson("https://x.test/data", {
      nullOnError: true,
      signal: controller.signal,
    });

    controller.abort(new Error("caller cancelled"));

    await expect(work).rejects.toThrow("caller cancelled");
  });

  it("does not invoke fetch for an already-aborted caller", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }));
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(fetchJson("https://x.test/data", { signal: controller.signal })).rejects.toThrow(
      "already cancelled",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels a late response when fetch ignores caller abort", async () => {
    const pendingFetch = deferredResponse();
    const cancel = vi.fn().mockResolvedValue(undefined);
    mockFetch(() => pendingFetch.promise);
    const controller = new AbortController();
    let outcome = "pending";
    let caught: Error | undefined;
    const operation = fetchJson("https://x.test/data", {
      signal: controller.signal,
      timeoutMs: 10_000,
    }).then(
      () => {
        outcome = "resolved";
      },
      (error) => {
        caught = error as Error;
        outcome = "rejected";
      },
    );

    controller.abort(new Error("caller cancelled"));
    await flushTasks();
    expect(outcome).toBe("rejected");
    pendingFetch.resolve({
      body: { cancel },
      headers: new Headers({ "content-type": "application/json" }),
      ok: true,
      status: 200,
    } as unknown as Response);
    await flushTasks();
    await operation;

    expect(caught?.message).toBe("caller cancelled");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("owns a late response when fetch aborts synchronously during invocation", async () => {
    const pendingFetch = deferredResponse();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    mockFetch(() => {
      controller.abort(new Error("synchronous fetch abort"));
      return pendingFetch.promise;
    });

    await expect(fetchJson("https://x.test/data", { signal: controller.signal })).rejects.toThrow(
      "synchronous fetch abort",
    );
    pendingFetch.resolve({
      body: { cancel },
      headers: new Headers({ "content-type": "application/json" }),
      ok: true,
      status: 200,
    } as unknown as Response);
    await flushTasks();

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("observes a late rejection when fetch aborts synchronously during invocation", async () => {
    const pendingFetch = deferredResponse();
    const controller = new AbortController();
    vi.stubGlobal("fetch", (() => {
      controller.abort(new Error("synchronous fetch abort"));
      return pendingFetch.promise;
    }) as typeof fetch);
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      await expect(fetchJson("https://x.test/data", { signal: controller.signal })).rejects.toThrow(
        "synchronous fetch abort",
      );

      pendingFetch.reject(new Error("late fetch rejection"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });
});
