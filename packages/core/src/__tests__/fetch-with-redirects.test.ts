import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRedirects } from "../utils/fetchWithRedirects.js";
import { createPinnedFetchTransport } from "../utils/pinned-fetch.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    expect(releaseResponse).toHaveBeenCalledWith(redirect, { force: false });
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
    expect(releaseResponse).toHaveBeenCalledWith(redirect, { force: false });
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
    expect(releaseResponse).toHaveBeenCalledWith(redirect, { force: true });
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
});
