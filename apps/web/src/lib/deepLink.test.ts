import type { Waypoint } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDirectionsDeepLinkUrl,
  buildLocationShareUrl,
  DEEPLINK_UPDATE_EVENT,
  formatCameraParam,
  formatLabeledPoint,
  formatScheduleParam,
  paramsWithoutDeepLink,
  parseCameraParam,
  parseDeepLinkSearch,
  parseLabeledPoint,
  parseLngLatListParam,
  parseScheduleParam,
  shareCurrentUrl,
  shareUrl,
} from "./deepLink";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("builds a clean location-only link on the current locale path", () => {
    const href = buildLocationShareUrl(
      "https://maps.example/de?panel=directions&wp=50.1,6.1&ov=weather#old",
      {
        id: "stylePoi:42",
        coordinates: [-77.02573, 38.88859],
        name: "Smithsonian Institution Building",
        category: "museum",
        rawCategory: "culture/museum",
      },
    );
    const url = new URL(href);

    expect(`${url.origin}${url.pathname}`).toBe("https://maps.example/de");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("map")).toBe("38.88859,-77.02573,16,0,0");
    expect(url.searchParams.get("panel")).toBe("place");
    expect(url.searchParams.get("place")).toBe("stylePoi:42");
    expect(url.searchParams.get("at")).toBe("38.88859,-77.02573");
    expect(url.searchParams.get("name")).toBe("Smithsonian Institution Building");
    expect(url.searchParams.get("cat")).toBe("museum");
    expect(url.searchParams.get("raw")).toBe("culture/museum");
    expect(url.searchParams.has("wp")).toBe(false);
    expect(url.searchParams.has("ov")).toBe(false);
  });

  it("omits absent optional place metadata", () => {
    const url = new URL(
      buildLocationShareUrl("https://maps.example/", {
        id: "coordinate:38.888590--77.025730",
        coordinates: [-77.02573, 38.88859],
        name: "38.888590, -77.025730",
      }),
    );
    expect(url.searchParams.has("cat")).toBe(false);
    expect(url.searchParams.has("raw")).toBe(false);
  });

  it("shares the supplied URL without serializing current state", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { share, canShare: () => true, clipboard: { writeText } });

    expect(await shareUrl({ url: "https://maps.example/?at=38.8,-77.0", title: "Museum" })).toBe(
      "shared",
    );
    expect(share).toHaveBeenCalledWith({
      title: "Museum",
      text: undefined,
      url: "https://maps.example/?at=38.8,-77.0",
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to clipboard when Web Share is missing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    expect(await shareUrl({ url: "https://maps.example/location" })).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("https://maps.example/location");
  });

  it("falls back to clipboard when Web Share rejects its payload", async () => {
    const share = vi.fn().mockReturnValue(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, canShare: () => false, clipboard: { writeText } });

    expect(await shareUrl({ url: "https://maps.example/location" })).toBe("copied");
    expect(share).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("https://maps.example/location");
  });

  it("returns cancelled for an aborted Web Share without copying", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { share, canShare: () => true, clipboard: { writeText } });

    expect(await shareUrl({ url: "https://maps.example/location" })).toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to clipboard for a non-abort Web Share error", async () => {
    const share = vi.fn().mockRejectedValue(new Error("Share failed"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, canShare: () => true, clipboard: { writeText } });

    expect(await shareUrl({ url: "https://maps.example/location" })).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("https://maps.example/location");
  });

  it("returns unavailable when clipboard rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard failed"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    expect(await shareUrl({ url: "https://maps.example/location" })).toBe("unavailable");
  });

  it("returns unavailable when no sharing API is supported", async () => {
    vi.stubGlobal("navigator", {});

    expect(await shareUrl({ url: "https://maps.example/location" })).toBe("unavailable");
  });

  it("requests a deep-link update before delegating to the sharing primitive", async () => {
    const events: string[] = [];
    const share = vi.fn().mockImplementation(async () => {
      events.push("share");
    });
    vi.stubGlobal("navigator", { share, canShare: () => true });
    window.addEventListener(DEEPLINK_UPDATE_EVENT, () => events.push("update"), { once: true });

    expect(await shareCurrentUrl({ title: "Museum" })).toBe("shared");
    expect(events).toEqual(["update", "share"]);
    expect(share).toHaveBeenCalledWith({
      title: "Museum",
      text: undefined,
      url: window.location.href,
    });
  });
});

describe("buildDirectionsDeepLinkUrl", () => {
  it("encodes waypoints/mode/avoid in the deep-link vocabulary and round-trips", () => {
    const url = buildDirectionsDeepLinkUrl("https://maps.example", {
      waypoints: [
        { coords: [13.405, 52.52], label: "Berlin" },
        { coords: [9.99, 53.55], label: "Hamburg" },
      ],
      mode: "cycling",
      avoidFerries: true,
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/");
    expect(parsed.searchParams.get("panel")).toBe("directions");
    expect(parsed.searchParams.get("mode")).toBe("cycling");
    expect(parsed.searchParams.get("avoid")).toBe("ferries");
    expect(parsed.searchParams.getAll("wp")).toEqual(["52.52,13.405,Berlin", "53.55,9.99,Hamburg"]);
    const roundTrip = parseDeepLinkSearch(parsed.search);
    expect(roundTrip.directions?.waypoints).toHaveLength(2);
    expect(roundTrip.directions?.waypoints[0].coords).toEqual([13.405, 52.52]);
  });

  it("omits mode for driving and avoid when empty", () => {
    const url = buildDirectionsDeepLinkUrl("https://maps.example", {
      waypoints: [{ coords: [0, 0] }, { coords: [1, 1] }],
      mode: "driving",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.has("mode")).toBe(false);
    expect(parsed.searchParams.has("avoid")).toBe(false);
  });
});

describe("schedule deep-link param", () => {
  const waypoints: Waypoint[] = [
    {
      id: "a",
      coords: [0, 0],
      label: "A",
      type: "origin",
      schedule: { departAfter: "2026-09-02T09:30", timeZone: "Europe/Berlin" },
    },
    { id: "b", coords: [1, 1], label: "B", type: "waypoint" },
    {
      id: "c",
      coords: [2, 2],
      label: "C",
      type: "destination",
      schedule: { fixedAt: "2026-09-02T14:00", dwellSeconds: 1800 },
    },
  ];

  it("emits nothing for an unconstrained trip", () => {
    const plain = waypoints.map(({ schedule: _schedule, ...rest }) => rest);
    expect(formatScheduleParam(plain)).toBeNull();
  });

  it("round-trips constrained waypoints only", () => {
    const encoded = formatScheduleParam(waypoints);
    expect(encoded).toBe("1|0,d=2026-09-02T09:30,z=Europe/Berlin;2,f=2026-09-02T14:00,w=30");
    expect(parseScheduleParam(encoded)).toEqual({
      0: { departAfter: "2026-09-02T09:30", timeZone: "Europe/Berlin" },
      2: { fixedAt: "2026-09-02T14:00", dwellSeconds: 1800 },
    });
  });

  it("drops an unknown version wholesale", () => {
    expect(parseScheduleParam("2|0,d=2026-09-02T09:30")).toEqual({});
  });

  it("ignores an unknown key but keeps the record", () => {
    expect(parseScheduleParam("1|0,d=2026-09-02T09:30,q=nonsense")).toEqual({
      0: { departAfter: "2026-09-02T09:30" },
    });
  });

  it("drops a malformed wall clock, a bad index and a bad dwell", () => {
    expect(parseScheduleParam("1|0,d=tomorrow;x,f=2026-09-02T14:00;1,w=abc")).toEqual({});
  });

  it("returns nothing for an absent or shapeless value", () => {
    expect(parseScheduleParam(null)).toEqual({});
    expect(parseScheduleParam("nonsense")).toEqual({});
  });

  it("parses the sched param into the directions deep link", () => {
    const parsed = parseDeepLinkSearch(
      "?panel=directions&wp=0,0&wp=1,1&sched=1%7C0%2Ca%3D2026-09-02T14%3A00",
    );
    expect(parsed.directions?.schedules).toEqual({ 0: { arriveBy: "2026-09-02T14:00" } });
  });
});
