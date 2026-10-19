import { createNoopLogger } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../integration-clients";

const options = { maxBytes: 32, contentTypes: ["application/xml"] } as const;
const encode = (text: string) => new TextEncoder().encode(text);

function controlledResponse(headers: Record<string, string> = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
    { headers: { "Content-Type": "application/xml", ...headers } },
  );
  return { response, controller, cancel };
}

afterEach(() => vi.unstubAllGlobals());

describe("integration host text and streaming transport", () => {
  it("posts raw XML without JSON encoding and returns selected headers", async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response("<reply>ä</reply>", {
          headers: { "Content-Type": "Application/XML; charset=utf-8", ETag: '"v1"' },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await createHttpClient(createNoopLogger()).postText(
      "https://api.test/xml",
      "<request/>",
      { ...options, headers: { "Content-Type": "application/xml" }, responseHeaders: ["ETAG"] },
    );
    expect(result).toEqual({ status: 200, headers: { etag: '"v1"' }, body: "<reply>ä</reply>" });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe("<request/>");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("content-type")).toBe(
      "application/xml",
    );
  });

  it("returns bounded non-success text even when it is HTML instead of the requested format", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("<h1>Missing</h1>", { status: 404 })),
    );
    const result = await createHttpClient(createNoopLogger()).getText(
      "https://api.test/xml",
      options,
    );
    expect(result.status).toBe(404);
    expect(result.body).toBe("<h1>Missing</h1>");
  });

  it("uses a fallback only for an absent content type", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(encode("zip")))
      .mockResolvedValueOnce(new Response("<html/>"));
    vi.stubGlobal("fetch", fetch);
    const client = createHttpClient(createNoopLogger());
    const binaryOptions = {
      maxBytes: 3,
      contentTypes: ["application/zip"],
      fallbackContentType: "application/zip",
    };
    expect((await client.getBytes("https://api.test/archive", binaryOptions)).bytes).toEqual(
      encode("zip"),
    );
    await expect(client.getBytes("https://api.test/html", binaryOptions)).rejects.toThrow(
      /content type/i,
    );
  });

  it.each<Record<string, string>>([{ "Content-Type": "text/html" }, { "Content-Length": "100" }])(
    "cancels rejected stream responses before returning them: %s",
    async (headers) => {
      const source = controlledResponse(headers);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => source.response),
      );
      await expect(
        createHttpClient(createNoopLogger()).getStream("https://api.test/feed", options),
      ).rejects.toThrow();
      expect(source.cancel).toHaveBeenCalledOnce();
    },
  );

  it("enforces streamed bytes rather than character counts and cancels overflow", async () => {
    const source = controlledResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => source.response),
    );
    const work = createHttpClient(createNoopLogger()).getText("https://api.test/xml", {
      ...options,
      maxBytes: 3,
    });
    source.controller.enqueue(encode("ää"));
    await expect(work).rejects.toThrow(/too large/i);
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it("streams without eagerly draining the source and forwards consumer cancellation", async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(encode("x"));
    });
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(source, { headers: { "Content-Type": "application/xml" } })),
    );
    const result = await createHttpClient(createNoopLogger()).getStream(
      "https://api.test/feed",
      options,
    );
    expect(pull).not.toHaveBeenCalled();
    const reader = result.stream.getReader();
    expect((await reader.read()).value).toEqual(encode("x"));
    expect(pull).toHaveBeenCalledOnce();
    await reader.cancel("download abandoned");
    expect(cancel).toHaveBeenCalledWith("download abandoned");
  });

  it.each(["caller", "timeout"] as const)(
    "cancels a body stalled after headers on %s cancellation",
    async (mode) => {
      const source = controlledResponse();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => source.response),
      );
      const caller = new AbortController();
      const result = await createHttpClient(createNoopLogger()).getStream("https://api.test/feed", {
        ...options,
        signal: caller.signal,
        timeoutMs: mode === "timeout" ? 20 : 10_000,
      });
      const read = result.stream.getReader().read();
      const assertion = expect(read).rejects.toThrow();
      if (mode === "caller") caller.abort(new Error("retired"));
      await assertion;
      expect(source.cancel).toHaveBeenCalledOnce();
    },
  );

  it("returns bounded non-success streams without enforcing the successful content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("denied", { status: 403 })),
    );
    const result = await createHttpClient(createNoopLogger()).getStream(
      "https://api.test/feed",
      options,
    );
    expect(result.status).toBe(403);
    expect(await new Response(result.stream).text()).toBe("denied");
  });

  it("follows opt-in 203 redirects, strips credentials, and retains one deadline signal", async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response()));
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 203, headers: { Location: "https://downloads.test/feed" } }),
    );
    fetch.mockResolvedValueOnce(
      new Response("<feed/>", { headers: { "Content-Type": "application/xml" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await createHttpClient(createNoopLogger()).getText("https://api.test/feed", {
      ...options,
      headers: { Authorization: "Bearer private" },
      redirect: { allowedHosts: ["downloads.test"], follow203: true },
    });
    expect(result.body).toBe("<feed/>");
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.test/feed",
      "https://downloads.test/feed",
    ]);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has("Authorization")).toBe(false);
    expect(fetch.mock.calls[1]?.[1]?.signal).toBe(fetch.mock.calls[0]?.[1]?.signal);
  });

  it("rejects untrusted redirects and cancels the intermediate body", async () => {
    const source = controlledResponse();
    const response = new Response(source.response.body, {
      status: 302,
      headers: { Location: "https://evil.test/data" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response),
    );
    await expect(
      createHttpClient(createNoopLogger()).getText("https://api.test/feed", {
        ...options,
        redirect: { allowedHosts: ["downloads.test"] },
      }),
    ).rejects.toThrow(/not allowed/i);
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it("does not turn an empty redirect allowlist into unrestricted following", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () => new Response(null, { status: 302, headers: { Location: "https://evil.test/data" } }),
      ),
    );
    await expect(
      createHttpClient(createNoopLogger()).getText("https://api.test/feed", {
        ...options,
        redirect: { allowedHosts: [] },
      }),
    ).rejects.toThrow(/allowlist|not allowed/i);
  });

  it("supports the same redirect policy for bounded JSON and bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { Location: "https://downloads.test/json" } }),
        )
        .mockResolvedValueOnce(
          new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }),
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { Location: "https://downloads.test/zip" } }),
        )
        .mockResolvedValueOnce(
          new Response(encode("zip"), { headers: { "Content-Type": "application/zip" } }),
        ),
    );
    const client = createHttpClient(createNoopLogger());
    const redirect = { allowedHosts: ["downloads.test"] };
    expect(
      (
        await client.getResponse("https://api.test/json", {
          ...options,
          contentTypes: ["application/json"],
          redirect,
        })
      ).body,
    ).toEqual({ ok: true });
    expect(
      (
        await client.getBytes("https://api.test/zip", {
          ...options,
          contentTypes: ["application/zip"],
          redirect,
        })
      ).bytes,
    ).toEqual(encode("zip"));
  });

  it("retains the JSON format check even if a caller allowlists an unrelated media type", async () => {
    const source = controlledResponse({ "Content-Type": "text/html" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => source.response),
    );
    const work = createHttpClient(createNoopLogger()).postResponse(
      "https://api.test/json",
      {},
      {
        ...options,
        contentTypes: ["text/html"],
      },
    );
    source.controller.enqueue(encode('{"ok":true}'));
    source.controller.close();
    await expect(work).rejects.toThrow(/content type/i);
  });

  it("retains same-origin credentials and never restores them after crossing an origin", async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response()));
    for (const location of [
      "https://api.test/same",
      "https://downloads.test/feed",
      "https://api.test/again",
    ]) {
      fetch.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: location } }),
      );
    }
    fetch.mockResolvedValueOnce(
      new Response("<feed/>", { headers: { "Content-Type": "application/xml" } }),
    );
    vi.stubGlobal("fetch", fetch);
    await createHttpClient(createNoopLogger()).getText("https://api.test/feed", {
      ...options,
      headers: {
        Authorization: "Bearer private",
        Cookie: "private=1",
        "Proxy-Authorization": "private",
      },
      redirect: { allowedHosts: ["api.test", "downloads.test"] },
    });
    for (const header of ["Authorization", "Cookie", "Proxy-Authorization"]) {
      expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).has(header))).toEqual([
        true,
        true,
        false,
        false,
      ]);
    }
  });

  it("honors 303 by replacing a raw text POST with a GET", async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response()));
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 303, headers: { Location: "/answer" } }),
    );
    fetch.mockResolvedValueOnce(
      new Response("<answer/>", { headers: { "Content-Type": "application/xml" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await createHttpClient(createNoopLogger()).postText(
      "https://api.test/xml",
      "<request/>",
      {
        ...options,
        redirect: { allowedHosts: ["api.test"] },
      },
    );
    expect(result.body).toBe("<answer/>");
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("GET");
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it("aborts unread streams and does not wait forever for a source cancellation hook", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(body, { headers: { "Content-Type": "application/xml" } })),
    );
    const controller = new AbortController();
    const result = await createHttpClient(createNoopLogger()).getStream("https://api.test/feed", {
      ...options,
      signal: controller.signal,
    });
    controller.abort(new Error("retired before read"));
    await expect(result.stream.getReader().read()).rejects.toThrow("retired before read");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

describe("redirect cleanup ownership", () => {
  it.each(["abort", "timeout"])(
    "honors %s while an intermediate cancel hook hangs",
    async (mode) => {
      vi.useFakeTimers();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const timer = new AbortController();
        setTimeout(() => timer.abort(new DOMException("Timed out", "TimeoutError")), ms);
        return timer.signal;
      });
      try {
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const fetch = vi.fn(
          () =>
            new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
              status: 302,
              headers: { Location: "/next" },
            }),
        );
        vi.stubGlobal("fetch", fetch);
        const controller = new AbortController();
        const outcome = createHttpClient(createNoopLogger())
          .getText("https://api.test/start", {
            ...options,
            signal: controller.signal,
            timeoutMs: 20,
            redirect: { allowedHosts: ["api.test"] },
          })
          .then(
            () => "resolved",
            () => "rejected",
          );
        await vi.advanceTimersByTimeAsync(1);
        expect(cancel).toHaveBeenCalledOnce();
        if (mode === "abort") controller.abort(new Error("retired"));
        await vi.advanceTimersByTimeAsync(20);
        let settled = false;
        void outcome.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(true);
        expect(await outcome).toBe("rejected");
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        timeout.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});

describe("trusted redirect transport security", () => {
  it.each(["http://api.test/next", "https://user:password@api.test/next"])(
    "rejects unsafe target %s before sending a POST body",
    async (target) => {
      const cancel = vi.fn();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
            status: 307,
            headers: { Location: target },
          }),
        )
        .mockResolvedValueOnce(
          new Response("<ok/>", { headers: { "content-type": "application/xml" } }),
        );
      vi.stubGlobal("fetch", fetch);
      await expect(
        createHttpClient(createNoopLogger()).postText(
          "https://api.test/ojp",
          "<private-location/>",
          { ...options, redirect: { allowedHosts: ["api.test"] } },
        ),
      ).rejects.toThrow(/redirect/i);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});

it("does not expose rejected Location credentials in errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://private-user:private-password@api.test/next" },
        }),
    ),
  );
  const error = await createHttpClient(createNoopLogger())
    .getText("https://api.test/start", { ...options, redirect: { allowedHosts: ["api.test"] } })
    .catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("private-user");
  expect(String(error)).not.toContain("private-password");
});
