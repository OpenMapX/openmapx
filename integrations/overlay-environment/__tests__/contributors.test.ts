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

/** Read the real registered route with controlled upstream bytes. */
async function readStations(boxes: unknown[], sensor: string) {
  const fetch = vi.fn(async (url: string) =>
    Response.json(String(url).includes("opensensemap") ? boxes : []),
  );
  vi.stubGlobal("fetch", fetch);
  const ctx = createMockIntegrationContext();
  setup(ctx);
  const route = ctx.registered.routes.find((r) => r.path === "/stations");
  if (!route) throw new Error("Missing /stations route");
  let body: unknown;
  const status = vi.fn();
  const reply = {
    send: vi.fn((value: unknown) => {
      body = value;
    }),
    status,
  };
  status.mockReturnValue(reply);
  await route.handler(
    { query: { south: "50", west: "-1", north: "53", east: "14", sensor } } as never,
    reply as never,
  );
  return { body, reply, fetch };
}

const measuredSensor = (title: string, value: string, unit = "°C") => ({
  title,
  unit,
  sensorType: "HDC1008",
  lastMeasurement: { value, createdAt: "2026-04-05T11:51:42.666Z" },
});
const stationBox = (id: string, sensors: unknown[], extra: Record<string, unknown> = {}) => ({
  _id: id,
  name: id,
  currentLocation: { coordinates: [13.431, 52.479] },
  exposure: "outdoor",
  sensors,
  ...extra,
});

it.each([
  ["temperature", "Temperatur", "19.19", 19.19, "°C"],
  ["temperature", "Temperature", "14.5", 14.5, "°C"],
  ["humidity", "rel. Luftfeuchte", "61.34", 61.34, "%"],
  ["humidity", "Humidity", "72.3", 72.3, "%"],
  ["pm25", "PM2.5", "2.1", 2.1, "µg/m³"],
  ["pm10", "PM10", "5.3", 5.3, "µg/m³"],
] as const)("maps %s from the upstream title %s", async (sensor, title, raw, value, unit) => {
  const { body } = await readStations(
    [stationBox("station", [measuredSensor(title, raw, unit)])],
    sensor,
  );
  expect(body).toEqual([
    expect.objectContaining({
      id: "station",
      name: "station",
      lat: 52.479,
      lng: 13.431,
      value,
      unit,
      sensorTitle: title,
      sensorType: "HDC1008",
      lastUpdated: "2026-04-05T11:51:42.666Z",
      exposure: "outdoor",
      model: "",
      allSensors: [{ title, value, unit }],
    }),
  ]);
});

it("keeps complete readings from matching boxes and skips malformed or nonmatching measurements", async () => {
  const german = stationBox(
    "Wittenau",
    [
      measuredSensor("Temperatur", "19.19"),
      measuredSensor("rel. Luftfeuchte", "61.34", "%"),
      measuredSensor("Luftdruck", "1006.96", "hPa"),
    ],
    { model: "homeWifi" },
  );
  const english = stationBox(
    "Bromley Station",
    [measuredSensor("Temperature", "14.5"), measuredSensor("Humidity", "72.3", "%")],
    { currentLocation: { coordinates: [-0.05, 51.41] } },
  );
  const measurementId = {
    ...measuredSensor("Temperatur", "0"),
    lastMeasurement: "57ff623df1b6070012db287e",
  };
  const missingMeasurement = { ...measuredSensor("Temperatur", "0"), lastMeasurement: undefined };
  const { body } = await readStations(
    [
      german,
      english,
      stationBox("PM Only", [measuredSensor("PM10", "5.3", "µg/m³")]),
      stationBox("Measurement ID", [measurementId]),
      stationBox("Missing measurement", [missingMeasurement]),
      stationBox("Bad value", [measuredSensor("Temperatur", "not-a-number")]),
      stationBox("Empty", []),
    ],
    "temperature",
  );
  expect(body).toEqual([
    expect.objectContaining({
      id: "Wittenau",
      name: "Wittenau",
      lat: 52.479,
      lng: 13.431,
      value: 19.19,
      model: "homeWifi",
      allSensors: [
        { title: "Temperatur", value: 19.19, unit: "°C" },
        { title: "rel. Luftfeuchte", value: 61.34, unit: "%" },
        { title: "Luftdruck", value: 1006.96, unit: "hPa" },
      ],
    }),
    expect.objectContaining({
      id: "Bromley Station",
      name: "Bromley Station",
      lat: 51.41,
      lng: -0.05,
      value: 14.5,
      model: "",
      allSensors: [
        { title: "Temperature", value: 14.5, unit: "°C" },
        { title: "Humidity", value: 72.3, unit: "%" },
      ],
    }),
  ]);
});

it("rejects an unknown sensor before acquiring upstream data", async () => {
  const { body, reply, fetch } = await readStations([], "unknown");
  expect(reply.status).toHaveBeenCalledWith(400);
  expect(body).toEqual({ message: "Invalid sensor type" });
  expect(fetch).not.toHaveBeenCalled();
});
