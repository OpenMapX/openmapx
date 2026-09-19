import { describe, expect, it, vi } from "vitest";
import { type StacItem, stacItemToImage, stacLinksToStreetLevelLinks } from "../provider";

const ITEM: StacItem = {
  id: "9f2916af-0000-4000-8000-000000000001",
  geometry: { type: "Point", coordinates: [2.3521, 48.8573] },
  properties: {
    datetime: "2025-09-23T13:33:04+00:00",
    "view:azimuth": 98,
    "pers:interior_orientation": { field_of_view: 360 },
    license: "CC-BY-SA-4.0",
  },
  providers: [{ name: "Some Contributor", roles: ["producer"] }],
  assets: {
    thumb: { href: "https://example.test/thumb.jpg" },
    sd: { href: "https://example.test/sd.jpg" },
    hd: { href: "https://example.test/hd.jpg" },
  },
  collection: "abf97111-0000-4000-8000-000000000002",
  links: [],
};

describe("stacItemToImage", () => {
  it("maps identity, position and provider", () => {
    const image = stacItemToImage(ITEM, "panoramax");
    expect(image.id).toBe(ITEM.id);
    expect(image.providerId).toBe("panoramax");
    expect(image.lngLat).toEqual([2.3521, 48.8573]);
  });

  it("reads the compass heading from view:azimuth", () => {
    expect(stacItemToImage(ITEM, "panoramax").heading).toBe(98);
  });

  it("detects a 360 image from a 360 degree field of view", () => {
    const image = stacItemToImage(ITEM, "panoramax");
    expect(image.isPano).toBe(true);
    expect(image.fovDeg).toBe(360);
  });

  describe("field of view", () => {
    const withLens = (
      orientation: NonNullable<StacItem["properties"]>["pers:interior_orientation"],
      exif?: Record<string, string>,
    ): StacItem => ({
      ...ITEM,
      properties: {
        ...ITEM.properties,
        "pers:interior_orientation": orientation,
        ...(exif ? { exif } : {}),
      },
    });

    it("takes Panoramax's own value when it knows the camera", () => {
      const image = stacItemToImage(
        withLens(
          { field_of_view: 92, sensor_array_dimensions: [5184, 3888] },
          {
            "Exif.Photo.FocalLengthIn35mmFilm": "15",
          },
        ),
        "panoramax",
      );
      expect(image.fovDeg).toBe(92);
    });

    it("works it out from the 35 mm-equivalent focal length over the frame's shape", () => {
      // A Xiaomi phone Panoramax rates at 72°: 25 mm equivalent on a 16:9 frame.
      const image = stacItemToImage(
        withLens(
          { camera_manufacturer: "Xiaomi", sensor_array_dimensions: [4608, 2592] },
          {
            "Exif.Photo.FocalLengthIn35mmFilm": "25",
          },
        ),
        "panoramax",
      );
      expect(image.fovDeg).toBe(74);
      expect(image.isPano).toBe(false);
    });

    it("assumes a phone's 70° when a phone photo carries no lens data", () => {
      // The A57 photo: the upload kept the maker and model, not the lens.
      const image = stacItemToImage(
        withLens(
          { camera_manufacturer: "OnePlus", sensor_array_dimensions: [4608, 3456] },
          {
            "Exif.Photo.FocalLengthIn35mmFilm": "0",
          },
        ),
        "panoramax",
      );
      expect(image.fovDeg).toBe(70);
    });

    it("leaves it unknown for any other camera without lens data", () => {
      const dashcam = stacItemToImage(
        withLens({ sensor_array_dimensions: [2704, 1520] }),
        "panoramax",
      );
      expect(dashcam.fovDeg).toBeUndefined();
      expect(dashcam.isPano).toBe(false);
      const sonyActionCam = stacItemToImage(
        withLens({ camera_manufacturer: "SONY", sensor_array_dimensions: [1920, 1080] }),
        "panoramax",
      );
      expect(sonyActionCam.fovDeg).toBeUndefined();
    });

    it("never gives a phone's panorama-shaped frame the phone default", () => {
      const image = stacItemToImage(
        withLens({ camera_manufacturer: "samsung", sensor_array_dimensions: [7776, 3888] }),
        "panoramax",
      );
      expect(image.fovDeg).toBeUndefined();
    });
  });

  it("reads the frame's shape from the sensor dimensions", () => {
    const flat: StacItem = {
      ...ITEM,
      properties: {
        ...ITEM.properties,
        "pers:interior_orientation": { sensor_array_dimensions: [4608, 3456] },
      },
    };
    expect(stacItemToImage(flat, "panoramax").aspectRatio).toBeCloseTo(4 / 3, 6);
  });

  it("leaves the frame's shape unknown when the sensor dimensions are missing", () => {
    expect(stacItemToImage(ITEM, "panoramax").aspectRatio).toBeUndefined();
  });

  it("maps assets and sequence", () => {
    const image = stacItemToImage(ITEM, "panoramax");
    expect(image.assets.hd).toBe("https://example.test/hd.jpg");
    expect(image.assets.thumb).toBe("https://example.test/thumb.jpg");
    expect(image.sequenceId).toBe(ITEM.collection);
  });

  it("normalises the SPDX licence for display", () => {
    expect(stacItemToImage(ITEM, "panoramax").license).toBe("CC BY-SA 4.0");
  });

  it("maps the capture timestamp and author", () => {
    const image = stacItemToImage(ITEM, "panoramax");
    expect(image.capturedAt).toBe("2025-09-23T13:33:04+00:00");
    expect(image.author).toBe("Some Contributor");
  });
});

describe("stacLinksToStreetLevelLinks", () => {
  const links = [
    { rel: "self", href: "https://example.test/self" },
    { rel: "license", href: "https://example.test/license" },
    {
      rel: "next",
      id: "0947c64b-0000-4000-8000-000000000003",
      geometry: { type: "Point" as const, coordinates: [2.35216, 48.85728] as [number, number] },
      href: "https://example.test/next",
    },
    {
      rel: "related",
      id: "a0606702-0000-4000-8000-000000000004",
      datetime: "2023-12-13T09:11:11Z",
      geometry: { type: "Point" as const, coordinates: [2.35201, 48.85735] as [number, number] },
      href: "https://example.test/related",
    },
  ];

  it("keeps only navigable relations", () => {
    const result = stacLinksToStreetLevelLinks(links, "panoramax");
    expect(result).toHaveLength(2);
    expect(result.map((l) => l.rel).sort()).toEqual(["next", "related"]);
  });

  it("carries id, position and capture time", () => {
    const related = stacLinksToStreetLevelLinks(links, "panoramax").find(
      (l) => l.rel === "related",
    );
    expect(related?.id).toBe("a0606702-0000-4000-8000-000000000004");
    expect(related?.lngLat).toEqual([2.35201, 48.85735]);
    expect(related?.capturedAt).toBe("2023-12-13T09:11:11Z");
    expect(related?.providerId).toBe("panoramax");
  });

  it("drops navigable relations that carry no id or geometry", () => {
    const result = stacLinksToStreetLevelLinks(
      [{ rel: "next", href: "https://example.test/next" }],
      "panoramax",
    );
    expect(result).toEqual([]);
  });
});

describe("author mapping", () => {
  it("reads the author from the Feature top-level providers with the producer role", () => {
    const image = stacItemToImage(
      {
        ...ITEM,
        providers: [
          { id: "p1", name: "motocultrice", roles: ["producer"] },
          { name: "raymond", roles: ["producer"] },
        ],
      },
      "panoramax",
    );
    expect(image.author).toBe("motocultrice");
  });

  it("falls back to the geovisio:producer string", () => {
    const image = stacItemToImage(
      {
        ...ITEM,
        providers: undefined,
        properties: { ...ITEM.properties, "geovisio:producer": "thetornado76" },
      },
      "panoramax",
    );
    expect(image.author).toBe("thetornado76");
  });
});

describe("searchImages", () => {
  it("requests the place_position band when a lookingAt point is given", async () => {
    const { createPanoramaxProvider } = await import("../provider");
    const fetchMock = vi.fn(async () => Response.json({ type: "FeatureCollection", features: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createPanoramaxProvider({
      instanceUrl: "https://example.test/api",
      tileUrlTemplate: "/tiles/{z}/{x}/{y}",
    });
    const results = await provider.searchImages({
      lngLat: [6.676, 51.179],
      radiusM: 400,
      lookingAt: [6.676, 51.179],
      headingToleranceDeg: 30,
      capturedAfter: "2018-01-01",
      limit: 20,
    });
    expect(results).toEqual([]);
    const url = String(fetchMock.mock.calls[0][0]);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://example.test/api/search");
    expect(parsed.searchParams.get("place_position")).toBe("6.676,51.179");
    expect(parsed.searchParams.get("place_distance")).toBe("30-400");
    expect(parsed.searchParams.get("place_fov_tolerance")).toBe("60");
    expect(parsed.searchParams.get("datetime")).toBe("2018-01-01T00:00:00Z/..");
    expect(parsed.searchParams.get("limit")).toBe("20");
    vi.unstubAllGlobals();
  });

  it("uses a bbox from the radius without a lookingAt point", async () => {
    const { createPanoramaxProvider } = await import("../provider");
    const fetchMock = vi.fn(async () => Response.json({ type: "FeatureCollection", features: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createPanoramaxProvider({
      instanceUrl: "https://example.test/api",
      tileUrlTemplate: "/tiles/{z}/{x}/{y}",
    });
    await provider.searchImages({ lngLat: [6.676, 51.179], radiusM: 400 });
    const parsed = new URL(String(fetchMock.mock.calls[0][0]));
    expect(parsed.searchParams.get("bbox")).toBeTruthy();
    expect(parsed.searchParams.get("place_position")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("retries once in bbox mode when the instance rejects the place band", async () => {
    const { createPanoramaxProvider } = await import("../provider");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad band", { status: 400 }))
      .mockResolvedValueOnce(Response.json({ type: "FeatureCollection", features: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createPanoramaxProvider({
      instanceUrl: "https://example.test/api",
      tileUrlTemplate: "/tiles/{z}/{x}/{y}",
    });
    await provider.searchImages({
      lngLat: [6.676, 51.179],
      radiusM: 400,
      lookingAt: [6.676, 51.179],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("bbox")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("maps items through stacItemToImage and declares its search capability", async () => {
    const { createPanoramaxProvider } = await import("../provider");
    const item = {
      id: "item-1",
      type: "Feature",
      geometry: { type: "Point", coordinates: [6.679, 51.1786] },
      properties: {
        datetime: "2019-09-10T06:24:40+00:00",
        license: "CC-BY-SA-4.0",
        "view:azimuth": 282,
        "pers:interior_orientation": {},
        "geovisio:producer": "motocultrice",
      },
      providers: [{ name: "motocultrice", roles: ["producer"] }],
      assets: { sd: { href: "https://example.test/sd.jpg" } },
    };
    const fetchMock = vi.fn(async () =>
      Response.json({ type: "FeatureCollection", features: [item] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createPanoramaxProvider({
      instanceUrl: "https://example.test/api",
      tileUrlTemplate: "/tiles/{z}/{x}/{y}",
    });
    const results = await provider.searchImages({ lngLat: [6.676, 51.179], radiusM: 400 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("item-1");
    expect(results[0].author).toBe("motocultrice");
    expect(provider.capabilities().search).toEqual({
      heading: false,
      capturedAfter: true,
      lookingAt: true,
    });
    expect(provider.capabilities().allowsNavigationUse).toBe(true);
    vi.unstubAllGlobals();
  });
});
