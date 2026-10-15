import type { SearchResult } from "@openmapx/core";
import { API_ENDPOINTS, apiClient } from "@openmapx/core";
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveImportPlaces } from "./resolve";
import type { ImportList } from "./types";

const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  id: "osm:node:1",
  label: "Café West, Berlin",
  name: "Café West",
  coordinates: [13, 52],
  confidence: 1,
  type: "poi",
  provider: "geocoding-photon",
  ...overrides,
});
const lists = (status: "approximate" | "needsLookup" = "approximate"): ImportList[] => [
  {
    name: "Trip",
    source: "Trip.csv",
    places: [
      { name: "Cafe West", status, ...(status === "approximate" ? { lat: 52, lng: 13 } : {}) },
    ],
  },
];
afterEach(() => vi.restoreAllMocks());
describe("import coordinate resolution", () => {
  it("uses our API with language/proximity and retains served source evidence", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue([result()]);
    const resolved = await resolveImportPlaces(lists(), {
      lang: "de",
      signal: new AbortController().signal,
    });
    expect(get).toHaveBeenCalledWith(
      API_ENDPOINTS.geocode,
      { q: "Cafe West", lang: "de", lat: "52.00", lng: "13.00" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(resolved[0].places[0]).toMatchObject({
      status: "located",
      lat: 52,
      lng: 13,
      geocoder: { provider: "geocoding-photon" },
    });
  });
  it.each([
    result({ coordinates: [13.1, 52] }),
    result({ name: "Different shop", label: "Different shop, Berlin" }),
  ])("rejects distant or mismatched results", async (match) => {
    vi.spyOn(apiClient, "get").mockResolvedValue([match]);
    expect((await resolveImportPlaces(lists()))[0].places[0]).toMatchObject({
      status: "approximate",
      lat: 52,
      lng: 13,
    });
  });
  it("never auto-locates an unhinted name-only chain from provider confidence", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue([
      result({
        name: "Starbucks",
        label: "Starbucks, Berlin",
        address: "Alexanderplatz 1, 10178 Berlin",
      }),
    ]);
    const value = lists("needsLookup");
    value[0].places[0].name = "Starbucks";
    expect((await resolveImportPlaces(value))[0].places[0].status).toBe("unresolved");
  });
  it.each([
    ["Rua Augusta 20, 1100 Lisbon", "Rua Augusta 20, 1100 Lisbon", "Cafe West", "located"],
    ["Rua Augusta 20, 1100 Lisbon", "Rua Augusta 21, 1100 Lisbon", "Cafe West", "unresolved"],
    ["Rua Augusta 20, 1100 Lisbon", "Rua Augusta 20, 1101 Lisbon", "Cafe West", "unresolved"],
    ["Main Road 20, SW1A London", "Main Road 20, SW1B London", "Cafe West", "unresolved"],
    ["Rua Augusta 20, 1100 Lisbon", "", "Cafe West", "unresolved"],
    ["Rua Augusta 20, 1100 Lisbon", "Rua Augusta 20, 1100 Lisbon", "Other cafe", "unresolved"],
  ])(
    "requires a matching address and name without a hint: %s / %s / %s",
    async (address, candidateAddress, name, status) => {
      vi.spyOn(apiClient, "get").mockResolvedValue([
        result({
          name,
          address: candidateAddress,
          label: "Cafe West, Rua Augusta 20, 1100 Lisbon",
          confidence: 1,
        }),
      ]);
      const value = lists("needsLookup");
      value[0].places[0].address = address;
      expect((await resolveImportPlaces(value))[0].places[0].status).toBe(status);
    },
  );
  it("requires the house number for an address-only lookup", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue([
      result({ name: "Main Street 12", label: "Main Street 12, Berlin", type: "address" }),
    ]);
    const value = lists("needsLookup");
    value[0].places[0] = {
      name: "Main Street 20",
      address: "Main Street 20",
      status: "needsLookup",
    };
    expect((await resolveImportPlaces(value))[0].places[0].status).toBe("unresolved");
  });
  it("accepts a matching address-only result regardless of provider confidence", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue([
      result({
        confidence: 0,
        name: "City Hall",
        label: "Main Street 20, Berlin",
        address: "Main Street 20, Berlin",
      }),
    ]);
    const value = lists("needsLookup");
    value[0].places[0] = {
      name: "Main Street 20",
      address: "Main Street 20",
      status: "needsLookup",
    };
    expect((await resolveImportPlaces(value))[0].places[0].status).toBe("located");
  });
  it("bounds concurrency at three, deduplicates identical queries, and reports progress", async () => {
    let active = 0;
    let maximum = 0;
    const release: (() => void)[] = [];
    const get = vi.spyOn(apiClient, "get").mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active--;
      return [] as never;
    });
    const value = lists("needsLookup");
    value[0].places = Array.from({ length: 7 }, (_, i) => ({
      name: `Place ${i % 6}`,
      status: "needsLookup",
    }));
    const onProgress = vi.fn();
    const pending = resolveImportPlaces(value, { onProgress });
    await waitFor(() => expect(release).toHaveLength(3));
    release.splice(0).forEach((fn) => {
      fn();
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(6));
    release.splice(0).forEach((fn) => {
      fn();
    });
    const resolved = await pending;
    expect(maximum).toBe(3);
    expect(get).toHaveBeenCalledTimes(6);
    expect(onProgress).toHaveBeenLastCalledWith(7, 7);
    expect(resolved[0].places.every((p) => p.status === "unresolved")).toBe(true);
  });
  it("aborts pending requests and never starts further work", async () => {
    const controller = new AbortController();
    const get = vi
      .spyOn(apiClient, "get")
      .mockImplementation(
        (_path, _params, options) =>
          new Promise((_resolve, reject) =>
            (options as { signal?: AbortSignal } | undefined)?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            ),
          ),
      );
    const value = lists("needsLookup");
    value[0].places = Array.from({ length: 10 }, (_, i) => ({
      name: `Place ${i}`,
      status: "needsLookup",
    }));
    const pending = resolveImportPlaces(value, { signal: controller.signal });
    expect(get).toHaveBeenCalledTimes(3);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(3);
  });
});
