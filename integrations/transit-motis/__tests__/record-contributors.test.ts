import type {
  AttributionIndexHandle,
  IntegrationContext,
  TransitProvider,
} from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { __testing, setupLocal } from "../local";

vi.mock("@motis-project/motis-client", async (original) => ({
  ...(await original<typeof import("@motis-project/motis-client")>()),
  stops: vi.fn(async () => ({ response: { ok: true } })),
}));
vi.mock("../adapter.js", async (original) => ({
  ...(await original<typeof import("../adapter.js")>()),
  getLegGeometry: vi.fn(async () => ({
    type: "LineString",
    coordinates: [
      [8, 50],
      [8.1, 50.1],
    ],
  })),
}));
vi.mock("../rentals-capability.js", () => ({
  primeRentalFormFactors: vi.fn(),
  getRentalFormFactors: () => [],
}));

const a = { sourceId: "feed_a", name: "A", notes: "Required notice" };
const b = { sourceId: "feed_b", name: "B" };
const index = {
  listMotisFeedTags: () => ["feed_a", "feed_b"],
  getById: (id: string) => ({ feed_a: a, feed_b: b })[id],
} as AttributionIndexHandle;
describe("MOTIS per-record acquisition", () => {
  it("captures mixed drawable routes individually and leaves unknown files empty", () => {
    const out = __testing.wrapLocal(
      [{ id: "ms:feed_a_1" }, { id: "ms:feed_b_2" }, { id: "ms:unknown_3" }],
      index,
    );
    expect(out.data).toEqual([
      { id: "ms:feed_a_1", contributors: [a] },
      { id: "ms:feed_b_2", contributors: [b] },
      { id: "ms:unknown_3", contributors: [] },
    ]);
    a.name = "Changed registry";
    expect((out.data[0] as { contributors?: (typeof a)[] }).contributors?.[0].name).toBe("A");
    a.name = "A";
  });
});

it("captures the exact requested service supplier on the production geometry adapter", async () => {
  let provider: TransitProvider | undefined;
  setupLocal(
    {
      config: {},
      attributionIndex: index,
      log: { info: vi.fn() },
      registerTransitProvider: (p: TransitProvider) => {
        provider = p;
      },
    } as unknown as IntegrationContext,
    { motisLocalInstance: { client: {} }, transitousInstance: { client: {} } } as Parameters<
      typeof setupLocal
    >[1],
  );
  const out = await provider?.getLegGeometry?.(
    "ms:feed_a_trip",
    "ms:feed_b_interchange",
    "ms:feed_b_other",
  );
  expect(out?.data.contributors).toEqual([a]);
  expect(out?.attributions).toEqual([a]);
  const adapter = await import("../adapter.js");
  vi.mocked(adapter.getLegGeometry).mockResolvedValueOnce(null);
  const empty = await provider?.getLegGeometry?.("ms:feed_a_trip");
  expect(empty?.data).toBeNull();
  expect(empty?.attributions).toEqual([]);
});
