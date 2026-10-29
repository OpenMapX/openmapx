import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "./client";
import { listOwnerShares, resolvePublicShare, unwrapSharingResponse } from "./sharing-sdk";

const client = createApiClient({ baseUrl: "https://sharing.example", credentials: "omit" });
afterEach(() => vi.unstubAllGlobals());
it("retains attribution-bearing public lists above the generic 8MiB allowance", async () => {
  const receipt = { sourceId: "provider", name: "Publisher", attributionText: "x".repeat(60000) };
  const place = { name: "Place", lat: 52, lng: 13, fieldContributors: { name: [receipt] } };
  const body = {
    type: "list",
    mode: "snapshot",
    name: "Trip",
    icon: null,
    places: Array.from({ length: 150 }, () => place),
  };
  expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeGreaterThan(8 * 1024 * 1024);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { headers: { "cache-control": "no-store" } })),
  );
  const result = unwrapSharingResponse(await resolvePublicShare("A".repeat(43), { client }));
  expect(result).toEqual(body);
  await expect(
    resolvePublicShare("A".repeat(43), { client, maxJsonBytes: 1024 }),
  ).rejects.toThrow();
});
it("rejects malformed bodies and missing confidentiality headers", async () => {
  for (const response of [
    Response.json({ shares: [] }),
    Response.json(
      { shares: [{ id: "bad" }] },
      { headers: { "cache-control": "private, no-store", pragma: "no-cache", vary: "Cookie" } },
    ),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(listOwnerShares({ client })).rejects.toThrow();
  }
});
it("propagates cancellation to fetch", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    resolvePublicShare("A".repeat(43), { client, signal: controller.signal }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});
