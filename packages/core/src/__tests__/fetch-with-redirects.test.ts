import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRedirects } from "../utils/fetchWithRedirects.js";
import { createPinnedFetchTransport } from "../utils/pinned-fetch.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("fetchWithRedirects", () => {
  it("follows non-standard 203 redirects when explicitly enabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 203,
          headers: { Location: "https://files.test/final.json" },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRedirects("https://api.test/feed", {
      follow203Redirect: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://files.test/final.json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("cancels an intermediate redirect body before requesting the next hop", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const redirect = {
      body: { cancel },
      headers: new Headers({ Location: "https://files.test/final.json" }),
      status: 302,
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRedirects("https://api.test/feed");

    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("does not follow 203 responses by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 203,
        headers: { Location: "https://files.test/final.json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRedirects("https://api.test/feed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(203);
    expect(response.headers.get("location")).toBe("https://files.test/final.json");
  });

  it("switches to GET after a 303 redirect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 303,
          headers: { Location: "/redirected" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRedirects("https://api.test/original", {
      body: "payload",
      headers: { "Content-Type": "application/xml" },
      method: "POST",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.test/redirected");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        body: undefined,
        method: "GET",
      }),
    );
    expect(await response.text()).toBe("ok");
  });

  it("rejects redirect targets outside the allowed host list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "https://metadata.internal/latest" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRedirects("https://api.test/original", {
        allowedRedirectHosts: ["api.test"],
      }),
    ).rejects.toThrow("Redirect target not allowed: metadata.internal");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels and releases a redirect response when redirect validation fails", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseResponse = vi.fn().mockResolvedValue(undefined);
    const redirect = {
      body: { cancel },
      headers: new Headers({ Location: "https://metadata.internal/latest" }),
      status: 302,
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirect));

    await expect(
      fetchWithRedirects("https://api.test/original", {
        allowedRedirectHosts: ["api.test"],
        releaseResponse,
      }),
    ).rejects.toThrow("Redirect target not allowed: metadata.internal");

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledWith(
      redirect,
      expect.objectContaining({ force: false, cleanupDeadlineAt: expect.any(Number) }),
    );
  });

  it("cancels and releases a redirect response when its Location is malformed", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseResponse = vi.fn().mockResolvedValue(undefined);
    const redirect = {
      body: { cancel },
      headers: new Headers({ Location: "http://[::1" }),
      status: 302,
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirect));

    await expect(
      fetchWithRedirects("https://api.test/original", { releaseResponse }),
    ).rejects.toThrow(/invalid url/i);

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledWith(
      redirect,
      expect.objectContaining({ force: false, cleanupDeadlineAt: expect.any(Number) }),
    );
  });

  it("forces destruction exactly once when redirect-body cancellation rejects", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    const close = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const redirect = {
      body: { cancel },
      headers: new Headers({ Location: "https://metadata.internal/latest" }),
      status: 302,
    } as unknown as Response;
    const transport = createPinnedFetchTransport({
      createDispatcher: () => ({ close, destroy }),
      fetchImplementation: vi.fn().mockResolvedValue(redirect),
    });
    const releaseResponse = vi.fn((response: Response, options?: { force?: boolean }) =>
      transport.releaseResponse(response, options),
    );

    await expect(
      fetchWithRedirects("https://api.test/original", {
        allowedRedirectHosts: ["api.test"],
        pinnedFetchImplementation: transport.fetch,
        releaseResponse,
        resolveConnectionAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toThrow("Redirect target not allowed: metadata.internal");

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledWith(
      redirect,
      expect.objectContaining({ force: true, cleanupDeadlineAt: expect.any(Number) }),
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await transport.dispose();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects non-http redirect targets", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "file:///etc/passwd" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithRedirects("https://api.test/original")).rejects.toThrow(
      "Redirect target protocol not allowed: file:",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows wildcard redirect host suffixes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: "https://files.example.test/final.json" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRedirects("https://api.example.test/original", {
      allowedRedirectHosts: ["*.example.test"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await response.text()).toBe("ok");
  });

  it.each([
    ["https://api.test:443/original", "http://api.test/original"],
    ["https://api.test:443/original", "https://api.test:8443/original"],
  ])("rejects a credential redirect that changes the protected origin", async (initial, target) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: target } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRedirects(initial, { allowedRedirectOrigin: "https://api.test" }),
    ).rejects.toThrow(/redirect target origin not allowed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes the already validated address set to the pinned transport for every hop", async () => {
    const pinnedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: "https://redirect.test/final" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const validatedAddresses = vi.fn(async (url: URL) => [
      {
        address: url.hostname === "api.test" ? "93.184.216.34" : "93.184.216.35",
        family: 4 as const,
      },
    ]);

    await fetchWithRedirects("https://api.test/original", {
      resolveConnectionAddresses: validatedAddresses,
      pinnedFetchImplementation: pinnedFetch,
    });

    expect(validatedAddresses).toHaveBeenNthCalledWith(1, new URL("https://api.test/original"));
    expect(validatedAddresses).toHaveBeenNthCalledWith(2, new URL("https://redirect.test/final"));
    expect(pinnedFetch).toHaveBeenNthCalledWith(
      1,
      "https://api.test/original",
      [{ address: "93.184.216.34", family: 4 }],
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(pinnedFetch).toHaveBeenNthCalledWith(
      2,
      "https://redirect.test/final",
      [{ address: "93.184.216.35", family: 4 }],
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("includes a never-settling connection resolver in the hop timeout", async () => {
    const pinnedFetch = vi.fn();
    let outcome = "pending";
    const operation = fetchWithRedirects("https://api.test/original", {
      timeoutMs: 30,
      resolveConnectionAddresses: async () => await new Promise<never>(() => {}),
      pinnedFetchImplementation: pinnedFetch,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    const settled = await settlesWithin(operation, 100);

    expect(settled).toBe(true);
    expect(outcome).toBe("rejected");
    expect(pinnedFetch).not.toHaveBeenCalled();
    await operation;
  });

  it("does not invoke a connection resolver after caller abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("fixture abort"));
    const resolveConnectionAddresses = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]);

    await expect(
      fetchWithRedirects("https://api.test/original", {
        signal: controller.signal,
        resolveConnectionAddresses,
        pinnedFetchImplementation: vi.fn(),
      }),
    ).rejects.toThrow(/fixture abort/i);
    expect(resolveConnectionAddresses).not.toHaveBeenCalled();
  });

  it("observes a late resolver resolution after synchronous abort during invocation", async () => {
    const controller = new AbortController();
    const lateResolver = deferred<Array<{ address: string; family: 4 }>>();
    const observeSettlement = vi.spyOn(lateResolver.promise, "then");
    const pinnedFetch = vi.fn();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(
      fetchWithRedirects("https://api.test/original", {
        signal: controller.signal,
        resolveConnectionAddresses: () => {
          controller.abort(new Error("synchronous resolver abort"));
          return lateResolver.promise;
        },
        pinnedFetchImplementation: pinnedFetch,
      }),
    ).rejects.toThrow("synchronous resolver abort");

    expect(observeSettlement).toHaveBeenCalled();
    lateResolver.resolve([{ address: "93.184.216.34", family: 4 }]);
    await flushTasks();

    expect(pinnedFetch).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(removeEventListener).not.toHaveBeenCalled();
  });

  it("observes a late resolver rejection after synchronous abort during invocation", async () => {
    const controller = new AbortController();
    const lateResolver = deferred<Array<{ address: string; family: 4 }>>();
    const pinnedFetch = vi.fn();
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      await expect(
        fetchWithRedirects("https://api.test/original", {
          signal: controller.signal,
          resolveConnectionAddresses: () => {
            controller.abort(new Error("synchronous resolver abort"));
            return lateResolver.promise;
          },
          pinnedFetchImplementation: pinnedFetch,
        }),
      ).rejects.toThrow("synchronous resolver abort");

      lateResolver.reject(new Error("late resolver rejection"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
      expect(pinnedFetch).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("bounds a pinned fetch that ignores timeout and releases its late response", async () => {
    const lateFetch = deferred<Response>();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const lateResponse = {
      body: { cancel },
      headers: new Headers(),
      status: 200,
    } as unknown as Response;
    const close = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const transport = createPinnedFetchTransport({
      createDispatcher: () => ({ close, destroy }),
      fetchImplementation: () => lateFetch.promise,
    });
    const releaseResponse = vi.fn((response: Response, options) =>
      transport.releaseResponse(response, options),
    );
    let outcome = "pending";
    const operation = fetchWithRedirects("https://api.test/original", {
      timeoutMs: 30,
      resolveConnectionAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedFetchImplementation: transport.fetch,
      releaseResponse,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    const settledBeforeLateResponse = await settlesWithin(operation, 100);
    lateFetch.resolve(lateResponse);
    await flushTasks();
    await operation;

    expect(settledBeforeLateResponse).toBe(true);
    expect(outcome).toBe("rejected");
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledWith(
      lateResponse,
      expect.objectContaining({ force: false, cleanupDeadlineAt: expect.any(Number) }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    await transport.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds a global fetch that ignores timeout and cancels its late response", async () => {
    const lateFetch = deferred<Response>();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const lateResponse = {
      body: { cancel },
      headers: new Headers(),
      status: 200,
    } as unknown as Response;
    let outcome = "pending";
    const operation = fetchWithRedirects("https://api.test/original", {
      timeoutMs: 30,
      fetchImplementation: () => lateFetch.promise,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    const settledBeforeLateResponse = await settlesWithin(operation, 100);
    lateFetch.resolve(lateResponse);
    await flushTasks();
    await operation;

    expect(settledBeforeLateResponse).toBe(true);
    expect(outcome).toBe("rejected");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds late cleanup and removes its abort listener when caller abort wins", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const lateFetch = deferred<Response>();
    const cancel = vi.fn(async () => await new Promise<void>(() => {}));
    const releaseResponse = vi.fn(async () => await new Promise<void>(() => {}));
    const lateResponse = {
      body: { cancel },
      headers: new Headers(),
      status: 200,
    } as unknown as Response;
    let outcome = "pending";
    const operation = fetchWithRedirects("https://api.test/original", {
      signal: controller.signal,
      fetchImplementation: () => lateFetch.promise,
      releaseResponse,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    controller.abort(new Error("fixture abort"));
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("rejected");
    lateFetch.resolve(lateResponse);
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledWith(
      lateResponse,
      expect.objectContaining({ force: true, cleanupDeadlineAt: expect.any(Number) }),
    );
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener.mock.calls[0]?.[0]).toBe("abort");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains ownership when caller aborts a pending redirect-hop fetch", async () => {
    const controller = new AbortController();
    const lateFetch = deferred<Response>();
    const redirectCancel = vi.fn().mockResolvedValue(undefined);
    const lateCancel = vi.fn().mockResolvedValue(undefined);
    const redirect = {
      body: { cancel: redirectCancel },
      headers: new Headers({ Location: "https://files.test/final" }),
      status: 302,
    } as unknown as Response;
    const lateResponse = {
      body: { cancel: lateCancel },
      headers: new Headers(),
      status: 200,
    } as unknown as Response;
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(redirect)
      .mockImplementationOnce(() => lateFetch.promise);
    const releaseResponse = vi.fn().mockResolvedValue(undefined);
    let outcome = "pending";
    const operation = fetchWithRedirects("https://api.test/original", {
      signal: controller.signal,
      fetchImplementation,
      releaseResponse,
    }).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));

    controller.abort(new Error("fixture redirect abort"));
    const settledBeforeLateResponse = await settlesWithin(operation, 50);
    lateFetch.resolve(lateResponse);
    await flushTasks();
    await operation;

    expect(settledBeforeLateResponse).toBe(true);
    expect(outcome).toBe("rejected");
    expect(redirectCancel).toHaveBeenCalledOnce();
    expect(lateCancel).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledTimes(2);
  });

  it("observes a late fetch rejection without replacing the caller abort", async () => {
    const controller = new AbortController();
    const lateFetch = deferred<Response>();
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      let caught: Error | undefined;
      const operation = fetchWithRedirects("https://api.test/original", {
        signal: controller.signal,
        fetchImplementation: () => lateFetch.promise,
      }).catch((error) => {
        caught = error as Error;
      });

      controller.abort(new Error("authoritative caller abort"));
      const settledBeforeLateRejection = await settlesWithin(operation, 50);
      lateFetch.reject(new Error("late transport failure"));
      await flushTasks();
      await operation;

      expect(settledBeforeLateRejection).toBe(true);
      expect(caught?.message).toBe("authoritative caller abort");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("owns a late pinned response when transport aborts synchronously during invocation", async () => {
    const controller = new AbortController();
    const lateFetch = deferred<Response>();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const lateResponse = {
      body: { cancel },
      headers: new Headers(),
      status: 200,
    } as unknown as Response;
    const close = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const fetchImplementation = vi.fn(() => lateFetch.promise);
    const transport = createPinnedFetchTransport({
      createDispatcher: () => ({ close, destroy }),
      fetchImplementation,
    });
    const pinnedFetchImplementation = vi.fn((input, addresses, init) => {
      controller.abort(new Error("synchronous transport abort"));
      return transport.fetch(input, addresses, init);
    });
    const releaseResponse = vi.fn((response: Response, options) =>
      transport.releaseResponse(response, options),
    );

    await expect(
      fetchWithRedirects("https://api.test/original", {
        signal: controller.signal,
        resolveConnectionAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
        pinnedFetchImplementation,
        releaseResponse,
      }),
    ).rejects.toThrow("synchronous transport abort");
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());

    lateFetch.resolve(lateResponse);
    await flushTasks();

    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledOnce();
    expect(releaseResponse).toHaveBeenCalledWith(
      lateResponse,
      expect.objectContaining({ force: false, cleanupDeadlineAt: expect.any(Number) }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    await transport.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it("observes a pinned rejection after transport aborts synchronously during invocation", async () => {
    const controller = new AbortController();
    const lateFetch = deferred<Response>();
    const close = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const fetchImplementation = vi.fn(() => lateFetch.promise);
    const transport = createPinnedFetchTransport({
      createDispatcher: () => ({ close, destroy }),
      fetchImplementation,
    });
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    try {
      await expect(
        fetchWithRedirects("https://api.test/original", {
          signal: controller.signal,
          resolveConnectionAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
          pinnedFetchImplementation: (input, addresses, init) => {
            controller.abort(new Error("synchronous transport abort"));
            return transport.fetch(input, addresses, init);
          },
          releaseResponse: transport.releaseResponse,
        }),
      ).rejects.toThrow("synchronous transport abort");
      await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());

      lateFetch.reject(new Error("late pinned rejection"));
      await flushTasks();

      expect(unhandled).toEqual([]);
      expect(close).toHaveBeenCalledOnce();
      expect(destroy).not.toHaveBeenCalled();
      await transport.dispose();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });
});
