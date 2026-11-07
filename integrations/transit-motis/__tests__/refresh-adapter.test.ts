import { createMotisInstance } from "@openmapx/mobility-core/motis-client";
import { expect, it, vi } from "vitest";
import { refreshTrip } from "../adapter";
import itinerary from "./fixtures/re1-26839-transitous-trip.json";

function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const instance = createMotisInstance({
    baseUrl: "http://motis.test",
    prefix: "ms:",
    provider: "ms",
  });
  instance.client.setConfig({ fetch });
  return { instance, fetch };
}
it.each([400, 404, 429, 500, 503])(
  "preserves HTTP %i as unavailable instead of a gone itinerary",
  async (status) => {
    const f = fixture();
    f.fetch.mockResolvedValue(
      Response.json({ error: "temporary or unrecognized failure" }, { status }),
    );
    await expect(refreshTrip(f.instance, "bound-id")).rejects.toThrow(
      "MOTIS itinerary refresh unavailable",
    );
  },
);
it("preserves network failure and missing successful payload as unavailable", async () => {
  const f = fixture();
  f.fetch
    .mockRejectedValueOnce(new Error("network timeout"))
    .mockResolvedValueOnce(Response.json(null));
  await expect(refreshTrip(f.instance, "bound-id")).rejects.toThrow();
  await expect(refreshTrip(f.instance, "bound-id")).rejects.toThrow();
});
it("accepts only the pinned explicit no-legs-reconstructed answer as gone", async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(Response.json({ error: "no legs reconstructed" }, { status: 400 }));
  expect(await refreshTrip(f.instance, "bound-id")).toBeNull();
});
it("maps successful real SDK responses", async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(Response.json(itinerary));
  expect(await refreshTrip(f.instance, "bound-id", { datasetEpoch: "epoch" })).toMatchObject({
    datasetEpoch: "epoch",
    legs: expect.any(Array),
  });
});
