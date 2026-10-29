import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestJsonScope } from "./requestJsonScope";

// These tests drive the real fetchJson through a stubbed fetch with standards
// shaped Response bodies, so sharing, bypass and failure behaviour are observed
// at the same boundary production uses.

let fetchMock: ReturnType<typeof vi.fn>;
let respond: (url: string) => Response | Promise<Response>;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  respond = (url) => json({ url, nested: { list: [1, 2, 3] } });
  fetchMock = vi.fn(async (input: unknown) => respond(String(input)));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const URL_A = "https://example.test/a";

describe("createRequestJsonScope", () => {
  it("shares one pending request among concurrent identical callers", async () => {
    const gate = Promise.withResolvers<void>();
    respond = async (url) => {
      await gate.promise;
      return json({ url });
    };
    const { getJson } = createRequestJsonScope();
    const first = getJson(URL_A);
    const second = getJson(URL_A);
    gate.resolve();
    expect(await first).toEqual({ url: URL_A });
    expect(await second).toEqual({ url: URL_A });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a response that settled before a later caller arrived", async () => {
    const scope = createRequestJsonScope();
    await scope.getJson(URL_A);
    await scope.getJson(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never shares scopes with each other", async () => {
    await createRequestJsonScope().getJson(URL_A);
    await createRequestJsonScope().getJson(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives every consumer an independent copy of the raw JSON", async () => {
    const scope = createRequestJsonScope();
    const first = await scope.getJson<{ nested: { list: number[] } }>(URL_A);
    first.nested.list.push(99);
    const second = await scope.getJson<{ nested: { list: number[] } }>(URL_A);
    expect(second.nested.list).toEqual([1, 2, 3]);
    expect(second).not.toBe(first);
  });

  describe("request identity", () => {
    it.each([
      ["URL", { url: "https://example.test/b" }],
      ["Accept representation", { headers: { Accept: "text/plain" } }],
      ["timeout", { options: { timeoutMs: 1234 } }],
      ["byte ceiling", { options: { maxBytes: 4321 } }],
      ["label", { options: { label: "Other" } }],
      ["omitted User-Agent", { options: { userAgent: null } }],
      ["explicit User-Agent", { options: { userAgent: "Custom/1" } }],
      ["User-Agent header value", { headers: { "User-Agent": "Header/1" } }],
    ] as const)("does not collide on %s", async (_name, variant) => {
      const scope = createRequestJsonScope();
      const base = { headers: { Accept: "application/json" }, timeoutMs: 3000 };
      await scope.getJson(URL_A, base);
      const next = {
        ...base,
        ...("options" in variant ? variant.options : {}),
        ...("headers" in variant ? { headers: { ...base.headers, ...variant.headers } } : {}),
      };
      await scope.getJson("url" in variant ? variant.url : URL_A, next);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("normalizes representation header case", async () => {
      const scope = createRequestJsonScope();
      await scope.getJson(URL_A, { headers: { Accept: "application/json" } });
      await scope.getJson(URL_A, { headers: { accept: "application/json" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("keeps caller User-Agent spelling and merge behaviour distinct", async () => {
      const scope = createRequestJsonScope();
      const agent = "Caller/1";
      await scope.getJson(URL_A, { headers: { "User-Agent": agent } });
      // fetchJson merges `User-Agent` over its default but sends `user-agent` beside it.
      await scope.getJson(URL_A, { headers: { "user-agent": agent } });
      await scope.getJson(URL_A, { headers: { "User-Agent": agent, "user-agent": agent } });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await scope.getJson(URL_A, { headers: { "User-Agent": agent } });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("keeps fetchJson's request shape for an eligible caller User-Agent header", async () => {
      const { getJson } = createRequestJsonScope();
      await getJson(URL_A, {
        headers: { "User-Agent": "Caller/1", Accept: "application/json" },
        timeoutMs: 4000,
      });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(init.headers).toEqual({ "User-Agent": "Caller/1", Accept: "application/json" });
      expect(init.redirect).toBe("error");
    });
  });

  describe("bypass", () => {
    it.each([
      ["Authorization", { headers: { Authorization: "Bearer secret" } }],
      ["Cookie", { headers: { Cookie: "sid=1" } }],
      ["custom credential header", { headers: { "X-Api-Key": "secret" } }],
      ["init", { init: { method: "POST", body: "{}" } }],
      ["errorMessage", { errorMessage: () => "custom" }],
      ["signal", { signal: new AbortController().signal }],
    ] as const)("does not memoize a call carrying %s", async (_name, options) => {
      const scope = createRequestJsonScope();
      await scope.getJson(URL_A, options);
      await scope.getJson(URL_A, options);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Eligible calls still do not see the bypassed ones.
      await scope.getJson(URL_A);
      await scope.getJson(URL_A);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("preserves the original options, including fail-closed redirects, when bypassing", async () => {
      const { getJson } = createRequestJsonScope();
      const controller = new AbortController();
      await getJson(URL_A, {
        headers: { Authorization: "Bearer secret" },
        signal: controller.signal,
      });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: "Bearer secret" });
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeDefined();
    });

    it("rejects a preaborted caller without starting a request", async () => {
      const scope = createRequestJsonScope();
      await scope.getJson(URL_A);
      fetchMock.mockClear();
      const controller = new AbortController();
      controller.abort(new Error("stop"));
      await expect(scope.getJson(URL_A, { signal: controller.signal })).rejects.toThrow("stop");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("treats an explicitly undefined signal as absent", async () => {
      const scope = createRequestJsonScope();
      await scope.getJson(URL_A, { signal: undefined });
      await scope.getJson(URL_A);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("failure", () => {
    it("shares an in-flight failure, then evicts it so a later call retries", async () => {
      const gate = Promise.withResolvers<void>();
      let calls = 0;
      respond = async (url) => {
        calls += 1;
        if (calls === 1) {
          await gate.promise;
          return new Response(null, { status: 503 });
        }
        return json({ url });
      };
      const scope = createRequestJsonScope();
      const first = scope.getJson(URL_A, { label: "Synthetic" });
      const second = scope.getJson(URL_A, { label: "Synthetic" });
      gate.resolve();
      await expect(first).rejects.toThrow("Synthetic HTTP 503");
      await expect(second).rejects.toThrow("Synthetic HTTP 503");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await expect(scope.getJson(URL_A, { label: "Synthetic" })).resolves.toEqual({ url: URL_A });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await scope.getJson(URL_A, { label: "Synthetic" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache an invalid JSON body", async () => {
      respond = () => new Response("not json", { headers: { "content-type": "application/json" } });
      const scope = createRequestJsonScope();
      await expect(scope.getJson(URL_A)).rejects.toThrow();
      respond = (url) => json({ url });
      await expect(scope.getJson(URL_A)).resolves.toEqual({ url: URL_A });
    });
  });

  describe("entry budget", () => {
    it("memoizes at most eight resources and lets overflow bypass without evicting", async () => {
      const scope = createRequestJsonScope();
      const urls = Array.from({ length: 9 }, (_, index) => `https://example.test/${index}`);
      for (const url of urls) await scope.getJson(url);
      expect(fetchMock).toHaveBeenCalledTimes(9);

      // The first eight stay shared; the overflow resource is refetched each time.
      for (const url of urls.slice(0, 8)) await scope.getJson(url);
      expect(fetchMock).toHaveBeenCalledTimes(9);
      await scope.getJson(urls[8] as string);
      await scope.getJson(urls[8] as string);
      expect(fetchMock).toHaveBeenCalledTimes(11);
    });

    it("frees budget when a pending entry fails", async () => {
      const scope = createRequestJsonScope();
      respond = () => new Response(null, { status: 500 });
      await expect(scope.getJson("https://example.test/fail")).rejects.toThrow();
      respond = (url) => json({ url });
      for (let index = 0; index < 8; index += 1)
        await scope.getJson(`https://example.test/${index}`);
      fetchMock.mockClear();
      for (let index = 0; index < 8; index += 1)
        await scope.getJson(`https://example.test/${index}`);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
