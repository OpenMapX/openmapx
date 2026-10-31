import type { TidesPayload } from "@openmapx/core";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";

const station = { id: "8518750", name: "The Battery", lat: 40.7006, lng: -74.0142 };

vi.mock("@openmapx/noaa-coops-data", () => ({
  fetchHighLowPredictions: async () => [{ time: "2026-10-31 04:12", type: "H", valueFt: 4.9 }],
  fetchTideCurve: async () => [{ time: "2026-10-31 04:00", valueFt: 4.8 }],
  fetchLatestWaterLevel: async () => null,
  fetchLatestMet: async () => null,
  findNearestStation: () => ({ station, distanceKm: 0.4 }),
  findStationById: () => station,
  loadStations: async () => [station],
}));

import { setup } from "../index";

describe("NOAA tides route", () => {
  it("labels heights with the MLLW datum and station-local wall time it requests", async () => {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const route = ctx.registered.routes.find((r) => r.path === "/tides");
    if (!route) throw new Error("missing tides route");
    let body: unknown;
    const reply = {
      header: () => reply,
      status: () => reply,
      send: (value: unknown) => {
        body = value;
        return reply;
      },
      type: () => reply,
    };
    await route.handler(
      { params: {}, headers: {}, body: null, query: { station: station.id } },
      reply,
    );
    const payload = body as TidesPayload;
    expect(payload.datum).toBe("MLLW");
    expect(payload.timeZone).toBe("lst_ldt");
  });
});
