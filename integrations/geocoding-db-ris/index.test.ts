import {
  createMockIntegrationContext,
  type FakeHttpClient,
  type FakeHttpRequest,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { setup } from "./index.js";
import type { RisStopPlace } from "./stations-types.js";

const CALL = { signal: new AbortController().signal, deadlineAt: Number.POSITIVE_INFINITY };

const KOELN_HBF: RisStopPlace = {
  evaNumber: "8000207",
  names: { DE: { nameLong: "Köln Hbf" } },
  metropolis: { DE: "Köln" },
  position: { longitude: 6.9589, latitude: 50.9431 },
  availableTransports: [{ type: "HIGH_SPEED_TRAIN" }],
};

let mockFetch: Mock<(input: FakeHttpRequest) => unknown>;
let transport: FakeHttpClient;

beforeEach(() => {
  mockFetch = vi
    .fn<(input: FakeHttpRequest) => unknown>()
    .mockResolvedValue({ stopPlaces: [KOELN_HBF] });
  transport = fakeHttpClient((request) => mockFetch(request));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function activate(config: Record<string, unknown> = { clientId: "cid", apiKey: "key" }) {
  const ctx = createMockIntegrationContext({ id: "geocoding-db-ris", config, http: transport });
  setup(ctx);
  return ctx;
}

describe("geocoding-db-ris search suggestions", () => {
  it("registers both a geocoding provider and a suggestion provider", () => {
    const ctx = activate();
    expect(ctx.registered.geocoding).toHaveLength(1);
    expect(ctx.registered.searchSuggestions.map((p) => p.id)).toEqual(["geocoding-db-ris"]);
  });

  it("contributes stations with EVA identities and DB attribution", async () => {
    const ctx = activate();
    const [provider] = ctx.registered.searchSuggestions;

    const result = await provider.searchSuggestions(
      { query: "Köln", lang: "de", limit: 8, proximity: [6.95, 50.94] },
      CALL,
    );

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      id: "eva:8000207",
      ids: { eva: "8000207" },
      type: "transit_stop",
      importance: 0.7,
      provider: "geocoding-db-ris",
    });
    expect(result.attributions).toEqual([expect.objectContaining({ sourceId: "db-ris-stations" })]);
  });

  it("skips the metered API for queries anchored outside central Europe", async () => {
    const ctx = activate();
    const [provider] = ctx.registered.searchSuggestions;

    const result = await provider.searchSuggestions(
      { query: "Köln", lang: "de", limit: 8, proximity: [-73.98, 40.75] },
      CALL,
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.suggestions).toEqual([]);
  });

  it("returns nothing when no credentials are configured", async () => {
    const ctx = activate({});
    const [provider] = ctx.registered.searchSuggestions;

    const result = await provider.searchSuggestions(
      { query: "Köln", lang: "de", limit: 8, proximity: [6.95, 50.94] },
      CALL,
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.suggestions).toEqual([]);
  });
});
