import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "../index";

afterEach(() => vi.unstubAllGlobals());
it("captures only the retained station supplier before dedupe and cache", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        String(url).includes("opensensemap")
          ? [
              {
                _id: "osm",
                name: "winner",
                currentLocation: { coordinates: [6, 51] },
                exposure: "outdoor",
                sensors: [
                  {
                    title: "Temperature",
                    unit: "°C",
                    sensorType: "temp",
                    lastMeasurement: { value: "20", createdAt: "2026-01-01" },
                  },
                ],
              },
            ]
          : [
              {
                id: 1,
                timestamp: "2026-01-01",
                location: { id: 1, latitude: "51", longitude: "6", indoor: 0 },
                sensor: { id: 1, sensor_type: { name: "BME280" } },
                sensordatavalues: [{ value_type: "temperature", value: "20" }],
              },
            ],
      ),
    ),
  );
  const cacheSet = vi.fn(async (_key: string, _value: unknown) => undefined);
  const ctx = createMockIntegrationContext();
  ctx.cache.set = cacheSet;
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/stations");
  if (!route) throw new Error("Missing /stations route");
  let body: { contributors?: { sourceId: string }[] }[] = [];
  const reply = {
    send: (v: unknown) => {
      body = v as typeof body;
    },
    status: () => reply,
  };
  await route.handler(
    { query: { south: "50", west: "5", north: "52", east: "7", sensor: "temperature" } } as never,
    reply as never,
  );
  expect(body).toHaveLength(1);
  expect(body[0].contributors?.map((a) => a.sourceId)).toEqual(["opensensemap"]);
  expect(cacheSet.mock.calls[0]?.[1]).toEqual(body);
});
it("UV has no Sensor.Community contribution", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json([
        {
          _id: "uv",
          name: "UV",
          currentLocation: { coordinates: [6, 51] },
          exposure: "outdoor",
          sensors: [
            {
              title: "UV",
              unit: "UV",
              sensorType: "uv",
              lastMeasurement: { value: "3", createdAt: "2026-01-01" },
            },
          ],
        },
      ]),
    ),
  );
  const ctx = createMockIntegrationContext();
  setup(ctx);
  let body: { contributors?: { sourceId: string }[] }[] = [];
  const reply = {
    send: (v: unknown) => {
      body = v as typeof body;
    },
    status: () => reply,
  };
  const route = ctx.registered.routes.find((r) => r.path === "/stations");
  if (!route) throw new Error("Missing /stations route");
  await route.handler(
    { query: { south: "50", west: "5", north: "52", east: "7", sensor: "uv" } } as never,
    reply as never,
  );
  expect(body[0].contributors?.map((a) => a.sourceId)).toEqual(["opensensemap"]);
});
