import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import { searchStreetLevelImages } from "./streetLevel";

describe("searchStreetLevelImages", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("serialises the query onto the provider's search route", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);
    await searchStreetLevelImages("panoramax", {
      lngLat: [6.6768, 51.1789],
      radiusM: 400,
      heading: 283,
      headingToleranceDeg: 30,
      capturedAfter: "2018-01-01T00:00:00Z",
      lookingAt: [6.6768, 51.1789],
      limit: 20,
    });
    expect(get).toHaveBeenCalledWith("/api/integrations/street-level-imagery-panoramax/search", {
      lng: "6.6768",
      lat: "51.1789",
      radius: "400",
      heading: "283",
      headingTolerance: "30",
      after: "2018-01-01T00:00:00Z",
      lookAtLng: "6.6768",
      lookAtLat: "51.1789",
      limit: "20",
    });
  });

  it("omits optional fields that were not given", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue([] as never);
    await searchStreetLevelImages("mapillary", { lngLat: [1, 2], radiusM: 100 });
    expect(get).toHaveBeenCalledWith("/api/integrations/street-level-imagery-mapillary/search", {
      lng: "1",
      lat: "2",
      radius: "100",
    });
  });

  it("answers empty on any error", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("502"));
    expect(await searchStreetLevelImages("panoramax", { lngLat: [1, 2], radiusM: 100 })).toEqual(
      [],
    );
  });
});
