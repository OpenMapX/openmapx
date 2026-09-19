import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import type { JunctionDecisionPoint } from "../../types/junction";
import type { Route } from "../../types/routing";
import type { StreetLevelImage } from "../../types/streetLevel";
import fixture from "../__fixtures__/junction/a57-neuss-exit20.json";
import { findJunctionDecisionPoints } from "../junctionDetect";
import { selectJunctionPhoto } from "../junctionPhoto";

const a57Route = fixture.route as unknown as Route;
const a57Point = findJunctionDecisionPoints(a57Route)[0];

interface FixtureImage {
  id: string;
  geometry?: { coordinates: [number, number] };
  properties?: Record<string, unknown>;
  providers?: { name: string; roles?: string[] }[];
}

/** Map one fixture Panoramax item to the normalised StreetLevelImage shape. */
function toImage(raw: FixtureImage): StreetLevelImage {
  return {
    id: raw.id,
    providerId: "panoramax",
    lngLat: raw.geometry?.coordinates ?? [0, 0],
    heading: raw.properties?.["view:azimuth"] as number | undefined,
    capturedAt: raw.properties?.datetime as string | undefined,
    isPano: false,
    fovDeg: 70,
    assets: {},
    author: raw.properties?.["geovisio:producer"] as string | undefined,
    license: "CC BY-SA 4.0",
  };
}

const images = (fixture.images as unknown as FixtureImage[]).map(toImage);

// 2026-09-15: the 2019-09 items are 7 years old, inside the 8-year window.
const NOW = new Date("2026-09-15T12:00:00Z");

const LAT = 51.18;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT * Math.PI) / 180);

/** A straight road of `lengthM` at `bearingDeg`, sampled every 10 m. */
function straightRoad(bearingDeg: number, lengthM: number): LngLat[] {
  const rad = (bearingDeg * Math.PI) / 180;
  const points: LngLat[] = [];
  for (let walked = 0; walked <= lengthM; walked += 10) {
    points.push([
      ((Math.sin(rad) * walked) / M_PER_DEG_LNG) as number,
      LAT + (Math.cos(rad) * walked) / M_PER_DEG_LAT,
    ]);
  }
  return points;
}

/** The point `meters` along a road sampled every 10 m. */
function pointAlong(road: LngLat[], meters: number): LngLat {
  return road[Math.round(meters / 10)];
}

describe("selectJunctionPhoto on the A57 fixture", () => {
  it("selects the upstream frame that shows the exit lane and the gantry", () => {
    const selected = selectJunctionPhoto(images, a57Point, NOW);
    // All 2019-09 frames come from one drive, so the one closest to ~80 m
    // before the split wins: far enough to see the boards, close enough that
    // the exit lane has opened. The 2025 frames face the other carriageway, the
    // 600 m frame is out of the band and the downstream frame fails the
    // upstream rule.
    expect(selected?.id).toBe("caea047f-f3c0-4819-8354-11805e6597c3");
  });

  it("prefers a newer capture month over a better distance", () => {
    const close = images.find((image) => image.id.startsWith("caea047f"))!;
    const farther = images.find((image) => image.id.startsWith("5f5dcbc8"))!;
    const newerFarther = { ...farther, id: "newer", capturedAt: "2024-05-01T08:00:00Z" };
    expect(selectJunctionPhoto([close, newerFarther], a57Point, NOW)?.id).toBe("newer");
  });

  it("treats frames from the same drive as equally recent", () => {
    const close = images.find((image) => image.id.startsWith("caea047f"))!;
    // A second later in the same drive, but further from the ~80 m sweet spot.
    const later = images.find((image) => image.id.startsWith("b77f03dc"))!;
    expect(selectJunctionPhoto([later, close], a57Point, NOW)?.id).toBe(close.id);
  });

  describe("with the point where the exit lanes begin", () => {
    const at84 = images.find((image) => image.id.startsWith("caea047f"))!;
    const at57 = images.find((image) => image.id.startsWith("b77f03dc"))!;
    // The next frame of the same drive, 35 m before the split: all five lanes
    // are painted under the gantry. OSM adds the fifth lane 41 m before it.
    const at35: StreetLevelImage = {
      ...at57,
      id: "c8462718-1f2a-4480-933c-b6914aa142a3",
      lngLat: [6.677331862, 51.178847745],
      heading: 283,
      capturedAt: "2019-09-10T06:24:36.795000+00:00",
    };

    it("takes the frame where the exit lanes already exist", () => {
      const frames = [at84, at57, at35];
      expect(selectJunctionPhoto(frames, a57Point, NOW)?.id).toBe(at84.id);
      expect(selectJunctionPhoto(frames, a57Point, NOW, { fullLanesFromMeters: 41 })?.id).toBe(
        at35.id,
      );
    });

    it("takes the frame nearest the lanes' start when none is past it", () => {
      expect(
        selectJunctionPhoto([at84, at57], a57Point, NOW, { fullLanesFromMeters: 41 })?.id,
      ).toBe(at57.id);
    });

    it("keeps the usual distance when the lanes exist long before the split", () => {
      expect(
        selectJunctionPhoto([at84, at57, at35], a57Point, NOW, { fullLanesFromMeters: 400 })?.id,
      ).toBe(at84.id);
    });
  });

  it("rejects the downstream frame even though it faces along the road", () => {
    const downstream = images.find((image) => image.id.startsWith("b6653d58"))!;
    expect(selectJunctionPhoto([downstream], a57Point, NOW)).toBeNull();
  });

  it("rejects old imagery when the age limit shrinks", () => {
    expect(selectJunctionPhoto(images, a57Point, NOW, { maxAgeYears: 5 })).toBeNull();
  });

  it("judges the heading against the road at the photo's own position", () => {
    // A curving approach: the road at the photo runs 40° off the bearing read
    // 100 m before the split, and the photo faces the road it was shot from.
    const road = straightRoad(243, 300);
    const point: JunctionDecisionPoint = {
      stepIndex: 1,
      kind: "exit",
      side: "right",
      point: road[road.length - 1],
      alongMeters: 300,
      approachBearing: 283,
      divergenceDeg: 17,
      activeLanes: [],
    };
    const photo: StreetLevelImage = {
      id: "curve",
      providerId: "panoramax",
      lngLat: pointAlong(road, 220),
      heading: 243,
      capturedAt: "2024-05-01T08:00:00Z",
      isPano: false,
      fovDeg: 70,
      assets: {},
    };
    expect(selectJunctionPhoto([photo], point, NOW)).toBeNull();
    expect(selectJunctionPhoto([photo], point, NOW, { geometry: road })?.id).toBe("curve");
  });

  it("rejects a photo taken off the route when the route is known", () => {
    // ~40 m off the carriageway: still plausibly "before the exit, facing it",
    // so only the route itself rules it out.
    const aside = images
      .filter((image) => image.id.startsWith("caea047f"))
      .map((image) => ({
        ...image,
        lngLat: [image.lngLat[0], image.lngLat[1] + 0.00036] as LngLat,
      }));
    expect(selectJunctionPhoto(aside, a57Point, NOW)).not.toBeNull();
    expect(selectJunctionPhoto(aside, a57Point, NOW, { geometry: a57Route.geometry })).toBeNull();
  });

  it("drops images without a heading", () => {
    const noHeading = images.map((image) => ({ ...image, heading: undefined }));
    expect(selectJunctionPhoto(noHeading, a57Point, NOW)).toBeNull();
  });
});
