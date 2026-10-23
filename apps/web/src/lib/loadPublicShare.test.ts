import { afterEach, expect, it, vi } from "vitest";
import { configureApiClient } from "../../../../packages/core/src/api/client";

vi.mock("@openmapx/core/server-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core/server-api")>()),
  serverApiUrl: () => "https://share-server.example",
}));

import { loadPublicShare } from "./loadPublicShare";

afterEach(() => {
  vi.unstubAllGlobals();
  configureApiClient({ baseUrl: "http://localhost:3001", credentials: "include" });
});
it("uses anonymous request-local transport regardless of singleton configuration", async () => {
  configureApiClient({
    baseUrl: "https://browser.example",
    credentials: "include",
    headerInterceptor: () => ({ cookie: "private", authorization: "private" }),
  });
  const share = { type: "list", mode: "live", name: "Trip", icon: null, places: [] };
  const fetcher = vi.fn(async () =>
    Response.json(share, { headers: { "cache-control": "no-store" } }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await loadPublicShare("A".repeat(43))).toEqual({ status: "ok", share });
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`https://share-server.example/api/shares/${"A".repeat(43)}`);
  expect(init.credentials).toBe("omit");
  expect(init.cache).toBe("no-store");
  expect(new Headers(init.headers).has("cookie")).toBe(false);
  expect(new Headers(init.headers).has("authorization")).toBe(false);
});
it("distinguishes invalid/expired links from malformed or unavailable services", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await loadPublicShare("invalid")).toEqual({ status: "not-found" });
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(Response.json({ error: "Share link not found" }, { status: 404 }));
  expect(await loadPublicShare("A".repeat(43))).toEqual({ status: "not-found" });
  fetcher.mockResolvedValue(Response.json({}, { headers: { "cache-control": "no-store" } }));
  expect(await loadPublicShare("A".repeat(43))).toEqual({ status: "unavailable" });
  fetcher.mockRejectedValueOnce(new Error("internal"));
  expect(await loadPublicShare("A".repeat(43))).toEqual({ status: "unavailable" });
});
