import type { TidesPayload } from "@openmapx/core";
import {
  createMockIntegrationContext,
  createPassthroughCache,
} from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.useRealTimers();
});

async function readTides(query: Record<string, string>, values = new Map<string, unknown>()) {
  const cache = createPassthroughCache();
  cache.get = async <T>(key: string) => (values.get(key) as T) ?? null;
  cache.set = async (key, value) => {
    values.set(key, value);
  };
  const ctx = createMockIntegrationContext({ cache });
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
  await route.handler({ params: {}, headers: {}, body: null, query }, reply);
  return body as TidesPayload;
}

describe("NOAA tides route", () => {
  it("rebuilds coordinate lookups cached before heights named their source", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const values = new Map<string, unknown>([
      ["tides:contributors-v1:40.7006,-74.0142:2026-10-31", { station, datum: "MLLW" }],
    ]);

    const payload = await readTides({ lat: "40.7006", lng: "-74.0142" }, values);

    expect(payload.heightSource).toBe("prediction");
  });

  it("labels heights with the MLLW datum and station-local wall time it requests", async () => {
    const payload = await readTides({ station: station.id });
    expect(payload.datum).toBe("MLLW");
    expect(payload.timeZone).toBe("lst_ldt");
    expect(payload.heightSource).toBe("prediction");
  });
});
