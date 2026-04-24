import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRedirects } from "../utils/fetchWithRedirects.js";

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
});
