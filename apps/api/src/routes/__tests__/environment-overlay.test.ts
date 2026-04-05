import { describe, expect, it } from "vitest";

/**
 * Tests for the overlay-environment integration's station processing logic.
 * These tests simulate the openSenseMap API response format and verify
 * that sensor title matching, measurement extraction, and response shaping
 * work correctly.
 */

// Sensor title map (copied from integration for testing without importing)
const SENSOR_TITLE_MAP: Record<string, string[]> = {
  temperature: ["temperatur", "temperature", "lufttemperatur", "temp", "air temperature"],
  humidity: ["rel. luftfeuchte", "luftfeuchte", "humidity", "relative humidity"],
  pm25: ["pm2.5", "pm 2.5", "feinstaub pm2.5"],
  pm10: ["pm10", "pm 10", "feinstaub pm10"],
  pressure: ["luftdruck", "pressure", "air pressure", "barometric pressure"],
  uv: ["uv-intensität", "uv intensity", "uv"],
  noise: ["lautstärke", "noise", "loudness", "schallpegel"],
};

interface SensorReading {
  title: string;
  value: number;
  unit: string;
}

interface Station {
  id: string;
  name: string;
  lat: number;
  lng: number;
  value: number;
  unit: string;
  sensorTitle: string;
  sensorType: string;
  lastUpdated: string;
  exposure: string;
  model: string;
  allSensors: SensorReading[];
}

interface OpenSenseMapBox {
  _id: string;
  name: string;
  currentLocation: { coordinates: [number, number] };
  lastMeasurementAt?: string;
  exposure: string;
  model?: string;
  sensors: {
    title: string;
    unit: string;
    sensorType: string;
    lastMeasurement?: { value: string; createdAt: string } | string;
  }[];
}

/**
 * Extracted station processing logic — mirrors the loop in index.ts.
 * This is the pure function we're testing.
 */
function processBoxes(boxes: OpenSenseMapBox[], sensorType: string): Station[] {
  const sensorTitles = SENSOR_TITLE_MAP[sensorType];
  if (!sensorTitles) return [];

  const stations: Station[] = [];
  for (const box of boxes) {
    if (!box.sensors?.length) continue;

    const allSensors: SensorReading[] = [];
    for (const s of box.sensors) {
      const m = s.lastMeasurement;
      if (!m || typeof m === "string") continue;
      const v = Number.parseFloat(m.value);
      if (Number.isNaN(v)) continue;
      allSensors.push({ title: s.title, value: v, unit: s.unit });
    }

    for (const sensor of box.sensors) {
      if (!sensorTitles.includes(sensor.title?.toLowerCase())) continue;
      const meas = sensor.lastMeasurement;
      if (!meas || typeof meas === "string") continue;
      const val = Number.parseFloat(meas.value);
      if (Number.isNaN(val)) continue;

      stations.push({
        id: box._id,
        name: box.name,
        lat: box.currentLocation.coordinates[1],
        lng: box.currentLocation.coordinates[0],
        value: val,
        unit: sensor.unit,
        sensorTitle: sensor.title,
        sensorType: sensor.sensorType,
        lastUpdated: meas.createdAt,
        exposure: box.exposure,
        model: box.model ?? "",
        allSensors,
      });
      break;
    }
  }
  return stations;
}

// Fixtures modeled on real openSenseMap API responses

const BERLIN_BOX_WITH_TEMP: OpenSenseMapBox = {
  _id: "582473be40198a001010e1a3",
  name: "Wittenau",
  currentLocation: { coordinates: [13.431, 52.479] },
  lastMeasurementAt: "2026-04-05T11:51:42.666Z",
  exposure: "outdoor",
  model: "homeWifi",
  sensors: [
    {
      title: "Temperatur",
      unit: "°C",
      sensorType: "HDC1008",
      lastMeasurement: { value: "19.19", createdAt: "2026-04-05T11:51:42.666Z" },
    },
    {
      title: "rel. Luftfeuchte",
      unit: "%",
      sensorType: "HDC1008",
      lastMeasurement: { value: "61.34", createdAt: "2026-04-05T11:51:42.000Z" },
    },
    {
      title: "Luftdruck",
      unit: "hPa",
      sensorType: "BMP280",
      lastMeasurement: { value: "1006.96", createdAt: "2026-04-05T11:51:42.000Z" },
    },
  ],
};

const LONDON_BOX_ENGLISH: OpenSenseMapBox = {
  _id: "aaa111",
  name: "Bromley Station",
  currentLocation: { coordinates: [-0.05, 51.41] },
  lastMeasurementAt: "2026-04-05T10:00:00Z",
  exposure: "outdoor",
  model: "homeEthernet",
  sensors: [
    {
      title: "Temperature",
      unit: "°C",
      sensorType: "BME280",
      lastMeasurement: { value: "14.5", createdAt: "2026-04-05T10:00:00Z" },
    },
    {
      title: "Humidity",
      unit: "%",
      sensorType: "BME280",
      lastMeasurement: { value: "72.3", createdAt: "2026-04-05T10:00:00Z" },
    },
  ],
};

const BOX_WITH_STRING_MEASUREMENT_ID: OpenSenseMapBox = {
  _id: "bbb222",
  name: "Old Station",
  currentLocation: { coordinates: [13.4, 52.5] },
  exposure: "outdoor",
  sensors: [
    {
      title: "Temperatur",
      unit: "°C",
      sensorType: "HDC1008",
      lastMeasurement: "57ff623df1b6070012db287e", // ID string, not object
    },
  ],
};

const BOX_NO_TEMP_SENSOR: OpenSenseMapBox = {
  _id: "ccc333",
  name: "PM Only",
  currentLocation: { coordinates: [13.45, 52.48] },
  lastMeasurementAt: "2026-04-05T11:50:00Z",
  exposure: "outdoor",
  sensors: [
    {
      title: "PM10",
      unit: "µg/m³",
      sensorType: "SDS011",
      lastMeasurement: { value: "5.3", createdAt: "2026-04-05T11:50:00Z" },
    },
    {
      title: "PM2.5",
      unit: "µg/m³",
      sensorType: "SDS011",
      lastMeasurement: { value: "2.1", createdAt: "2026-04-05T11:50:00Z" },
    },
  ],
};

const BOX_WITH_NULL_MEASUREMENT: OpenSenseMapBox = {
  _id: "ddd444",
  name: "Broken Sensor",
  currentLocation: { coordinates: [13.42, 52.51] },
  lastMeasurementAt: "2026-04-05T11:50:00Z",
  exposure: "outdoor",
  sensors: [
    {
      title: "Temperatur",
      unit: "°C",
      sensorType: "HDC1008",
      lastMeasurement: undefined,
    },
  ],
};

describe("overlay-environment station processing", () => {
  describe("temperature sensor matching", () => {
    it("matches German 'Temperatur' title", () => {
      const stations = processBoxes([BERLIN_BOX_WITH_TEMP], "temperature");
      expect(stations).toHaveLength(1);
      expect(stations[0].name).toBe("Wittenau");
      expect(stations[0].value).toBeCloseTo(19.19);
      expect(stations[0].unit).toBe("°C");
    });

    it("matches English 'Temperature' title", () => {
      const stations = processBoxes([LONDON_BOX_ENGLISH], "temperature");
      expect(stations).toHaveLength(1);
      expect(stations[0].name).toBe("Bromley Station");
      expect(stations[0].value).toBeCloseTo(14.5);
    });

    it("collects all sensors in allSensors array", () => {
      const stations = processBoxes([BERLIN_BOX_WITH_TEMP], "temperature");
      expect(stations[0].allSensors).toHaveLength(3);
      expect(stations[0].allSensors.map((s) => s.title)).toEqual([
        "Temperatur",
        "rel. Luftfeuchte",
        "Luftdruck",
      ]);
    });

    it("includes model from the box", () => {
      const stations = processBoxes([BERLIN_BOX_WITH_TEMP], "temperature");
      expect(stations[0].model).toBe("homeWifi");
    });
  });

  describe("sensor type filtering", () => {
    it("returns empty for boxes without matching sensor type", () => {
      const stations = processBoxes([BOX_NO_TEMP_SENSOR], "temperature");
      expect(stations).toHaveLength(0);
    });

    it("matches PM2.5 sensors", () => {
      const stations = processBoxes([BOX_NO_TEMP_SENSOR], "pm25");
      expect(stations).toHaveLength(1);
      expect(stations[0].value).toBeCloseTo(2.1);
    });

    it("matches PM10 sensors", () => {
      const stations = processBoxes([BOX_NO_TEMP_SENSOR], "pm10");
      expect(stations).toHaveLength(1);
      expect(stations[0].value).toBeCloseTo(5.3);
    });

    it("matches humidity with German title", () => {
      const stations = processBoxes([BERLIN_BOX_WITH_TEMP], "humidity");
      expect(stations).toHaveLength(1);
      expect(stations[0].value).toBeCloseTo(61.34);
    });

    it("matches humidity with English title", () => {
      const stations = processBoxes([LONDON_BOX_ENGLISH], "humidity");
      expect(stations).toHaveLength(1);
      expect(stations[0].value).toBeCloseTo(72.3);
    });

    it("returns empty for unknown sensor type", () => {
      const stations = processBoxes([BERLIN_BOX_WITH_TEMP], "unknown");
      expect(stations).toHaveLength(0);
    });
  });

  describe("measurement edge cases", () => {
    it("skips boxes where lastMeasurement is a string ID", () => {
      const stations = processBoxes([BOX_WITH_STRING_MEASUREMENT_ID], "temperature");
      expect(stations).toHaveLength(0);
    });

    it("skips boxes where lastMeasurement is undefined", () => {
      const stations = processBoxes([BOX_WITH_NULL_MEASUREMENT], "temperature");
      expect(stations).toHaveLength(0);
    });

    it("skips sensors with NaN values", () => {
      const box: OpenSenseMapBox = {
        _id: "eee555",
        name: "Bad Value",
        currentLocation: { coordinates: [13.4, 52.5] },
        exposure: "outdoor",
        sensors: [
          {
            title: "Temperatur",
            unit: "°C",
            sensorType: "HDC1008",
            lastMeasurement: { value: "not-a-number", createdAt: "2026-04-05T10:00:00Z" },
          },
        ],
      };
      const stations = processBoxes([box], "temperature");
      expect(stations).toHaveLength(0);
    });

    it("skips boxes with empty sensors array", () => {
      const box: OpenSenseMapBox = {
        _id: "fff666",
        name: "Empty",
        currentLocation: { coordinates: [13.4, 52.5] },
        exposure: "outdoor",
        sensors: [],
      };
      const stations = processBoxes([box], "temperature");
      expect(stations).toHaveLength(0);
    });
  });

  describe("multiple boxes", () => {
    it("processes multiple boxes and filters correctly", () => {
      const stations = processBoxes(
        [
          BERLIN_BOX_WITH_TEMP,
          LONDON_BOX_ENGLISH,
          BOX_NO_TEMP_SENSOR,
          BOX_WITH_STRING_MEASUREMENT_ID,
        ],
        "temperature",
      );
      expect(stations).toHaveLength(2);
      expect(stations.map((s) => s.name)).toEqual(["Wittenau", "Bromley Station"]);
    });

    it("extracts coordinates correctly", () => {
      const stations = processBoxes([BERLIN_BOX_WITH_TEMP], "temperature");
      expect(stations[0].lat).toBeCloseTo(52.479);
      expect(stations[0].lng).toBeCloseTo(13.431);
    });
  });
});
