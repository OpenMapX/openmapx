import { type CurrentWeather, lerpHex, solarAltitudeDeg, solarAzimuthDeg } from "@openmapx/core";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

/**
 * One light for the whole 3D scene: MapLibre's extrusion light, the landmark
 * models' three.js lights and the globe's sky colours all read it, so the
 * buildings, the models and the sky never disagree about where the sun is.
 *
 * MapLibre's light intensity sets contrast rather than brightness: a lower
 * value lifts the shaded walls and flattens the scene, a higher one deepens
 * the shade. The light colour multiplies the lit faces.
 */

export type ScenePreset = "day" | "golden" | "dusk" | "night" | "neutral";

interface SceneSky {
  skyColor: string;
  horizonColor: string;
  fogColor: string;
}

export interface SceneLight {
  /** "neutral" means real-time lighting is off (or suspended) outside night. */
  preset: ScenePreset;
  /** Where the light comes from, in degrees clockwise from north. */
  azimuthDeg: number;
  /** Angle from straight overhead, in degrees (MapLibre's polar angle). */
  polarDeg: number;
  /** MapLibre's directional light colour. */
  color: string;
  /** MapLibre's light intensity (contrast), 0 to 1. */
  intensity: number;
  /** The three.js directional light. */
  sunColor: string;
  sunIntensity: number;
  /** The three.js ambient light. */
  ambientColor: string;
  ambientIntensity: number;
  /** Landmark models switch to their unlit night palette. */
  night: boolean;
  /** The globe's sky; its horizon colour is also the globe's background. */
  sky: SceneSky;
}

export interface SceneLightInput {
  date: Date;
  center: { lat: number; lng: number };
  /** The resolved UI colour scheme is dark. */
  dark: boolean;
  /** The active base map is satellite imagery. */
  satellite: boolean;
  /** Real-time lighting ("Day and night") is on and not suspended. */
  realtime: boolean;
  /** How overcast it is at the centre, 0 to 1; 0 when unknown. */
  overcast: number;
}

/** The fixed light: today's MapLibre values, now anchored to the map. */
const FIXED_DIRECTION = { azimuthDeg: 210, polarDeg: 30 } as const;

const LIGHT_SKY: SceneSky = { skyColor: "#88c6fc", horizonColor: "#d6e8f7", fogColor: "#ffffff" };

export const NEUTRAL_SCENE_LIGHT: SceneLight = {
  preset: "neutral",
  ...FIXED_DIRECTION,
  color: "#ffffff",
  intensity: 0.4,
  sunColor: "#fff4df",
  sunIntensity: 2.2,
  ambientColor: "#ffffff",
  ambientIntensity: 1.4,
  night: false,
  sky: LIGHT_SKY,
};

/**
 * The dark theme's light: today's contrast with a faint cool tint. Landmarks
 * ignore the three.js values at night, when they draw their unlit palette.
 */
export const NIGHT_SCENE_LIGHT: SceneLight = {
  ...NEUTRAL_SCENE_LIGHT,
  preset: "night",
  color: "#e4e9f5",
  night: true,
  sky: { skyColor: "#0a0a1a", horizonColor: "#101828", fogColor: "#0a0a0a" },
};

interface Keyframe {
  altitudeDeg: number;
  color: string;
  intensity: number;
  sunIntensity: number;
  ambientColor: string;
  ambientIntensity: number;
  sky: SceneSky;
}

/**
 * The real-time light by solar altitude, interpolated between these. MapLibre
 * multiplies the light colour into every face of every building, roofs
 * included, while the ground stays untinted, so the tints stay faint.
 */
const SCENE_KEYFRAMES: readonly Keyframe[] = [
  {
    altitudeDeg: -4,
    color: "#e4def2",
    intensity: 0.3,
    sunIntensity: 1.1,
    ambientColor: "#d9d6ea",
    ambientIntensity: 0.9,
    sky: { skyColor: "#5d6fa8", horizonColor: "#e3b4a6", fogColor: "#c9c1d3" },
  },
  {
    altitudeDeg: 2,
    color: "#ffe8d0",
    intensity: 0.46,
    sunIntensity: 2.4,
    ambientColor: "#ffeedd",
    ambientIntensity: 1.2,
    sky: { skyColor: "#9cc1e6", horizonColor: "#ffd8ad", fogColor: "#ffe9d2" },
  },
  {
    altitudeDeg: 12,
    color: "#fffbf5",
    intensity: 0.4,
    sunIntensity: 2.2,
    ambientColor: "#ffffff",
    ambientIntensity: 1.4,
    sky: LIGHT_SKY,
  },
];

const OVERCAST_GREY = "#eceef2";
/** How far an overcast sky moves the light towards flat grey, at most. */
const OVERCAST_WEIGHT = 0.5;
/**
 * The polar angle stays in this range. MapLibre lights roofs by its cosine, so
 * a low winter or evening sun would turn every roof grey; a summer noon sun
 * would flatten the walls.
 */
const MIN_POLAR = 25;
const MAX_POLAR = 45;
/** Near the zenith the azimuth swings fast; it eases to the fixed direction over this band. */
const ZENITH_EASE_START = 70;
const ZENITH_EASE_END = 85;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

function roundAngle(degrees: number): number {
  const rounded = Math.round(degrees * 2) / 2;
  return ((rounded % 360) + 360) % 360;
}

function keyframeAt(altitudeDeg: number): Omit<Keyframe, "altitudeDeg"> {
  const first = SCENE_KEYFRAMES[0] as Keyframe;
  const last = SCENE_KEYFRAMES[SCENE_KEYFRAMES.length - 1] as Keyframe;
  if (altitudeDeg <= first.altitudeDeg) return first;
  if (altitudeDeg >= last.altitudeDeg) return last;
  for (let i = 1; i < SCENE_KEYFRAMES.length; i++) {
    const low = SCENE_KEYFRAMES[i - 1] as Keyframe;
    const high = SCENE_KEYFRAMES[i] as Keyframe;
    if (altitudeDeg > high.altitudeDeg) continue;
    const t = (altitudeDeg - low.altitudeDeg) / (high.altitudeDeg - low.altitudeDeg);
    return {
      color: lerpHex(low.color, high.color, t),
      intensity: lerp(low.intensity, high.intensity, t),
      sunIntensity: lerp(low.sunIntensity, high.sunIntensity, t),
      ambientColor: lerpHex(low.ambientColor, high.ambientColor, t),
      ambientIntensity: lerp(low.ambientIntensity, high.ambientIntensity, t),
      sky: {
        skyColor: lerpHex(low.sky.skyColor, high.sky.skyColor, t),
        horizonColor: lerpHex(low.sky.horizonColor, high.sky.horizonColor, t),
        fogColor: lerpHex(low.sky.fogColor, high.sky.fogColor, t),
      },
    };
  }
  return last;
}

function presetAt(altitudeDeg: number): ScenePreset {
  if (altitudeDeg >= 7) return "day";
  if (altitudeDeg >= -1) return "golden";
  return "dusk";
}

/** The sun's azimuth, eased along the shorter arc to the fixed direction near the zenith. */
function easedAzimuth(azimuthDeg: number, altitudeDeg: number): number {
  if (altitudeDeg <= ZENITH_EASE_START) return azimuthDeg;
  const t = Math.min(1, (altitudeDeg - ZENITH_EASE_START) / (ZENITH_EASE_END - ZENITH_EASE_START));
  const delta = ((FIXED_DIRECTION.azimuthDeg - azimuthDeg + 540) % 360) - 180;
  return azimuthDeg + delta * t;
}

export function computeSceneLight(input: SceneLightInput): SceneLight {
  if (input.dark && !input.satellite) return NIGHT_SCENE_LIGHT;
  if (!input.realtime) return NEUTRAL_SCENE_LIGHT;

  const { date, center } = input;
  const altitude = solarAltitudeDeg(date, center.lat, center.lng);
  const azimuth = solarAzimuthDeg(date, center.lat, center.lng);
  const frame = keyframeAt(altitude);
  const k = OVERCAST_WEIGHT * clamp(input.overcast, 0, 1);
  const color = k > 0 ? lerpHex(frame.color, OVERCAST_GREY, k) : frame.color;

  return {
    preset: presetAt(altitude),
    azimuthDeg: roundAngle(easedAzimuth(azimuth, altitude)),
    polarDeg: Math.round(clamp(90 - altitude, MIN_POLAR, MAX_POLAR) * 2) / 2,
    color,
    intensity: round2(frame.intensity * (1 - 0.4 * k)),
    sunColor: color,
    sunIntensity: round2(frame.sunIntensity * (1 - 0.5 * k)),
    ambientColor: frame.ambientColor,
    ambientIntensity: round2(frame.ambientIntensity),
    night: false,
    sky: frame.sky,
  };
}

/** WMO weather codes from fog upwards: fog, drizzle, rain, snow, showers, thunderstorms. */
const FIRST_OBSCURED_CODE = 45;
const OVERCAST_CODE = 3;

/** How overcast the current weather is, 0 to 1. */
export function overcastFromWeather(
  current: Pick<CurrentWeather, "cloudCover" | "weatherCode"> | null | undefined,
): number {
  if (!current) return 0;
  if (current.weatherCode >= FIRST_OBSCURED_CODE) return 1;
  if (current.cloudCover != null) return clamp((current.cloudCover - 50) / 50, 0, 1);
  return current.weatherCode === OVERCAST_CODE ? 0.6 : 0;
}

export function sceneLightEqual(a: SceneLight, b: SceneLight): boolean {
  return (
    a.preset === b.preset &&
    a.azimuthDeg === b.azimuthDeg &&
    a.polarDeg === b.polarDeg &&
    a.color === b.color &&
    a.intensity === b.intensity &&
    a.sunColor === b.sunColor &&
    a.sunIntensity === b.sunIntensity &&
    a.ambientColor === b.ambientColor &&
    a.ambientIntensity === b.ambientIntensity &&
    a.night === b.night &&
    a.sky.skyColor === b.sky.skyColor &&
    a.sky.horizonColor === b.sky.horizonColor &&
    a.sky.fogColor === b.sky.fogColor
  );
}

/** MapLibre's light for the scene, anchored to the map so it turns with it. */
export function toMapLibreLight(light: SceneLight): {
  anchor: "map";
  position: [number, number, number];
  color: string;
  intensity: number;
} {
  return {
    anchor: "map",
    position: [1.5, light.azimuthDeg, light.polarDeg],
    color: light.color,
    intensity: light.intensity,
  };
}

const RADIANS = Math.PI / 180;

/** Unit vector towards the light in a frame with x east, y north and z up. */
export function sunVector(
  light: Pick<SceneLight, "azimuthDeg" | "polarDeg">,
): [number, number, number] {
  const azimuth = light.azimuthDeg * RADIANS;
  const polar = light.polarDeg * RADIANS;
  return [
    Math.sin(azimuth) * Math.sin(polar),
    Math.cos(azimuth) * Math.sin(polar),
    Math.cos(polar),
  ];
}

interface SceneLightState {
  light: SceneLight;
  publish(light: SceneLight): void;
}

/** The current scene light. Only the host's scene lighting publishes to it. */
export const useSceneLightStore = create<SceneLightState>()((set) => ({
  light: NEUTRAL_SCENE_LIGHT,
  publish: (light) => set({ light }),
}));

/** Read part of the scene light; re-renders only when the selected values change. */
export function useSceneLight<T>(selector: (light: SceneLight) => T): T {
  return useSceneLightStore(useShallow((state: SceneLightState) => selector(state.light)));
}
