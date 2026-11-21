import { beforeEach, describe, expect, it, vi } from "vitest";

const sun = vi.hoisted(() => ({ altitude: 30, azimuth: 180, real: false }));

vi.mock("@openmapx/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...core,
    solarAltitudeDeg: (...args: Parameters<typeof core.solarAltitudeDeg>) =>
      sun.real ? core.solarAltitudeDeg(...args) : sun.altitude,
    solarAzimuthDeg: (...args: Parameters<typeof core.solarAzimuthDeg>) =>
      sun.real ? core.solarAzimuthDeg(...args) : sun.azimuth,
  };
});

import {
  computeSceneLight,
  NEUTRAL_SCENE_LIGHT,
  NIGHT_SCENE_LIGHT,
  overcastFromWeather,
  type SceneLightInput,
  sceneLightEqual,
  sunVector,
  toMapLibreLight,
  useSceneLightStore,
} from "./sceneLight";

function input(overrides: Partial<SceneLightInput> = {}): SceneLightInput {
  return {
    date: new Date("2026-06-21T12:00:00Z"),
    center: { lat: 50, lng: 8 },
    dark: false,
    satellite: false,
    realtime: true,
    overcast: 0,
    ...overrides,
  };
}

function at(altitude: number, azimuth = 180, overrides: Partial<SceneLightInput> = {}) {
  sun.altitude = altitude;
  sun.azimuth = azimuth;
  return computeSceneLight(input(overrides));
}

const DUSK = {
  color: "#e4def2",
  intensity: 0.3,
  sunIntensity: 1.1,
  ambientColor: "#d9d6ea",
  ambientIntensity: 0.9,
  sky: { skyColor: "#5d6fa8", horizonColor: "#e3b4a6", fogColor: "#c9c1d3" },
};
const GOLDEN = {
  color: "#ffe8d0",
  intensity: 0.46,
  sunIntensity: 2.4,
  ambientColor: "#ffeedd",
  ambientIntensity: 1.2,
  sky: { skyColor: "#9cc1e6", horizonColor: "#ffd8ad", fogColor: "#ffe9d2" },
};
const DAY = {
  color: "#fffbf5",
  intensity: 0.4,
  sunIntensity: 2.2,
  ambientColor: "#ffffff",
  ambientIntensity: 1.4,
  sky: { skyColor: "#88c6fc", horizonColor: "#d6e8f7", fogColor: "#ffffff" },
};

beforeEach(() => {
  sun.altitude = 30;
  sun.azimuth = 180;
  sun.real = false;
  useSceneLightStore.setState({ light: NEUTRAL_SCENE_LIGHT });
});

describe("computeSceneLight", () => {
  it("lights the dark theme as night whatever the realtime setting", () => {
    expect(computeSceneLight(input({ dark: true, realtime: true }))).toEqual(NIGHT_SCENE_LIGHT);
    expect(computeSceneLight(input({ dark: true, realtime: false }))).toEqual(NIGHT_SCENE_LIGHT);
    expect(NIGHT_SCENE_LIGHT).toMatchObject({
      preset: "night",
      azimuthDeg: 210,
      polarDeg: 30,
      color: "#e4e9f5",
      intensity: 0.4,
      night: true,
      sky: { skyColor: "#0a0a1a", horizonColor: "#101828", fogColor: "#0a0a0a" },
    });
  });

  it("never lights satellite imagery as night", () => {
    expect(computeSceneLight(input({ dark: true, satellite: true, realtime: false }))).toEqual(
      NEUTRAL_SCENE_LIGHT,
    );
  });

  it("keeps today's neutral light when Day and night is off", () => {
    expect(computeSceneLight(input({ realtime: false }))).toEqual(NEUTRAL_SCENE_LIGHT);
    expect(NEUTRAL_SCENE_LIGHT).toEqual({
      preset: "neutral",
      azimuthDeg: 210,
      polarDeg: 30,
      color: "#ffffff",
      intensity: 0.4,
      sunColor: "#fff4df",
      sunIntensity: 2.2,
      ambientColor: "#ffffff",
      ambientIntensity: 1.4,
      night: false,
      sky: { skyColor: "#88c6fc", horizonColor: "#d6e8f7", fogColor: "#ffffff" },
    });
  });

  it("hits each keyframe exactly", () => {
    expect(at(-4)).toMatchObject({ preset: "dusk", ...DUSK, sunColor: DUSK.color });
    expect(at(2)).toMatchObject({ preset: "golden", ...GOLDEN, sunColor: GOLDEN.color });
    expect(at(12)).toMatchObject({ preset: "day", ...DAY, sunColor: DAY.color });
  });

  it("interpolates between keyframes", () => {
    const light = at(7);
    expect(light.intensity).toBe(0.43);
    expect(light.sunIntensity).toBe(2.3);
    expect(light.color).toBe("#fff2e3");
    expect(light.preset).toBe("day");
  });

  it("labels the presets at the keyframe midpoints", () => {
    expect(at(6.9).preset).toBe("golden");
    expect(at(-1).preset).toBe("golden");
    expect(at(-1.1).preset).toBe("dusk");
  });

  it("clamps beyond the outer keyframes", () => {
    expect(at(-20)).toMatchObject(DUSK);
    expect(at(60)).toMatchObject(DAY);
  });

  it("clamps the polar angle", () => {
    expect(at(2).polarDeg).toBe(45);
    expect(at(80).polarDeg).toBe(25);
    expect(at(55).polarDeg).toBe(35);
  });

  it("passes the sun's azimuth through", () => {
    expect(at(30, 123.4).azimuthDeg).toBe(123.5);
  });

  it("eases the azimuth towards the neutral direction near the zenith", () => {
    expect(at(77.5, 100).azimuthDeg).toBe(155);
    expect(at(77.5, 20).azimuthDeg).toBe(295);
    expect(at(86, 20).azimuthDeg).toBe(210);
  });

  it.each([
    ["Sydney in December", { lat: -33.87, lng: 151.21 }, "2026-12-21T00:00:00Z"],
    ["Bangkok in June", { lat: 13.75, lng: 100.5 }, "2026-06-21T00:00:00Z"],
    ["Johannesburg in November", { lat: -26.2, lng: 28.05 }, "2026-11-21T00:00:00Z"],
    ["Berlin in June", { lat: 52.52, lng: 13.4 }, "2026-06-21T00:00:00Z"],
  ])("never swings the light more than a few degrees a minute: %s", (_, center, day) => {
    sun.real = true;
    const start = new Date(day).getTime();
    let previous: number | null = null;
    let largestStep = 0;
    for (let minute = 0; minute < 24 * 60; minute++) {
      const light = computeSceneLight(input({ center, date: new Date(start + minute * 60_000) }));
      if (previous !== null) {
        const step = Math.abs(((light.azimuthDeg - previous + 540) % 360) - 180);
        largestStep = Math.max(largestStep, step);
      }
      previous = light.azimuthDeg;
    }
    expect(largestStep).toBeLessThan(10);
  });

  it("normalises an azimuth that rounds to 360", () => {
    expect(at(30, 359.9).azimuthDeg).toBe(0);
  });

  it("softens and greys the light when overcast", () => {
    const light = at(30, 180, { overcast: 1 });
    expect(light.intensity).toBe(0.32);
    expect(light.sunIntensity).toBe(1.65);
    // Half way from the day colour towards the overcast grey.
    expect(light.color).toBe("#f6f5f4");
    expect(light.sunColor).toBe(light.color);
    expect(light.sky).toEqual(DAY.sky);
  });

  it("leaves night and neutral untouched by overcast", () => {
    expect(computeSceneLight(input({ dark: true, overcast: 1 }))).toEqual(NIGHT_SCENE_LIGHT);
    expect(computeSceneLight(input({ realtime: false, overcast: 1 }))).toEqual(NEUTRAL_SCENE_LIGHT);
  });
});

describe("overcastFromWeather", () => {
  it("maps weather to an overcast factor", () => {
    expect(overcastFromWeather({ cloudCover: 40, weatherCode: 2 })).toBe(0);
    expect(overcastFromWeather({ cloudCover: 75, weatherCode: 3 })).toBe(0.5);
    expect(overcastFromWeather({ cloudCover: 10, weatherCode: 61 })).toBe(1);
    expect(overcastFromWeather({ weatherCode: 3 })).toBe(0.6);
    expect(overcastFromWeather({ weatherCode: 1 })).toBe(0);
    expect(overcastFromWeather(null)).toBe(0);
    expect(overcastFromWeather(undefined)).toBe(0);
  });
});

describe("sceneLightEqual", () => {
  it("compares equal only when every field matches", () => {
    expect(sceneLightEqual(NEUTRAL_SCENE_LIGHT, { ...NEUTRAL_SCENE_LIGHT })).toBe(true);
    expect(sceneLightEqual(NEUTRAL_SCENE_LIGHT, { ...NEUTRAL_SCENE_LIGHT, azimuthDeg: 211 })).toBe(
      false,
    );
    expect(
      sceneLightEqual(NEUTRAL_SCENE_LIGHT, {
        ...NEUTRAL_SCENE_LIGHT,
        sky: { ...NEUTRAL_SCENE_LIGHT.sky, horizonColor: "#000000" },
      }),
    ).toBe(false);
  });
});

describe("conversions", () => {
  it("converts to a map-anchored MapLibre light", () => {
    expect(toMapLibreLight(NEUTRAL_SCENE_LIGHT)).toEqual({
      anchor: "map",
      position: [1.5, 210, 30],
      color: "#ffffff",
      intensity: 0.4,
    });
  });

  it("points the three.js sun towards the light", () => {
    const close = (actual: number[], expected: number[]) => {
      for (const [i, value] of expected.entries()) expect(actual[i]).toBeCloseTo(value, 6);
    };
    close(sunVector({ azimuthDeg: 0, polarDeg: 90 }), [0, 1, 0]);
    close(sunVector({ azimuthDeg: 90, polarDeg: 90 }), [1, 0, 0]);
    close(sunVector({ azimuthDeg: 45, polarDeg: 0 }), [0, 0, 1]);
    const rad = Math.PI / 180;
    close(sunVector(NEUTRAL_SCENE_LIGHT), [
      Math.sin(210 * rad) * Math.sin(30 * rad),
      Math.cos(210 * rad) * Math.sin(30 * rad),
      Math.cos(30 * rad),
    ]);
  });
});

describe("useSceneLightStore", () => {
  it("starts neutral and publishes a new light", () => {
    expect(useSceneLightStore.getState().light).toEqual(NEUTRAL_SCENE_LIGHT);
    useSceneLightStore.getState().publish(NIGHT_SCENE_LIGHT);
    expect(useSceneLightStore.getState().light).toEqual(NIGHT_SCENE_LIGHT);
  });
});
