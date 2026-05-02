import { describe, expect, it } from "vitest";
import {
  formatCameraParam,
  formatLabeledPoint,
  paramsWithoutDeepLink,
  parseCameraParam,
  parseDeepLinkSearch,
  parseLabeledPoint,
  parseLngLatListParam,
} from "./deepLink";

describe("deepLink helpers", () => {
  it("parses place links using the current schema", () => {
    const parsed = parseDeepLinkSearch(
      "?place=osm:node:123&at=52.517036,13.38886&name=Berlin&cat=city&raw=place/city",
    );

    expect(parsed.place).toEqual({
      id: "osm:node:123",
      coords: [13.38886, 52.517036],
      name: "Berlin",
      category: "city",
      rawCategory: "place/city",
    });
  });

  it("does not parse removed place coordinate aliases", () => {
    const parsed = parseDeepLinkSearch(
      "?place=osm:node:123&lat=52.517036&lng=13.38886&name=Berlin",
    );

    expect(parsed.place).toBe(undefined);
  });

  it("keeps unrelated query params when stripping deeplink state", () => {
    const params = paramsWithoutDeepLink("?token=reset-token&map=52.5,13.4,14&error=INVALID_TOKEN");

    expect(params.toString()).toBe("token=reset-token&error=INVALID_TOKEN");
  });

  it("round-trips camera and labeled waypoint values", () => {
    const camera = { center: [13.38886, 52.517036] as [number, number], zoom: 14.345 };
    const parsedCamera = parseCameraParam(formatCameraParam(camera));
    expect(parsedCamera?.center).toEqual([13.38886, 52.517036]);
    expect(parsedCamera?.zoom).toBe(14.35);

    const waypoint = {
      coords: [13.369, 52.525] as [number, number],
      label: "Berlin, Hauptbahnhof",
    };
    expect(parseLabeledPoint(formatLabeledPoint(waypoint))).toEqual(waypoint);
  });

  it("parses measurement point lists", () => {
    expect(parseLngLatListParam("52.1,13.1;52.2,13.2")).toEqual([
      [13.1, 52.1],
      [13.2, 52.2],
    ]);
  });
});
