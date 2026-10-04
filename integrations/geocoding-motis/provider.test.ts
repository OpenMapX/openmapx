import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@motis-project/motis-client", () => ({
  geocode: vi.fn(),
  reverseGeocode: vi.fn(),
}));

const motisClient = await import("@motis-project/motis-client");
const { motisGeocodingService, setMotisLocalUrl } = await import("./provider.js");

const MATCH = {
  type: "STOP",
  id: "de-DELFI_de:05334:1",
  name: "Aachen Bushof",
  lat: 50.776,
  lon: 6.09,
  score: 90,
  modes: ["BUS"],
};

beforeEach(() => {
  vi.mocked(motisClient.geocode).mockResolvedValue({ data: [MATCH] } as never);
  // The local endpoint answers the reachability probe.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 405 })),
  );
});

afterEach(() => {
  setMotisLocalUrl("http://localhost:8081");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("MOTIS geocoder attribution", () => {
  it("credits a self-hosted MOTIS that answered", async () => {
    setMotisLocalUrl("http://motis:8080");
    const [result] = await motisGeocodingService.autocomplete("bushof", "de");
    expect(result?.sourceIds).toEqual(["motis"]);
  });

  it("credits Transitous when the local endpoint is Transitous", async () => {
    setMotisLocalUrl("https://api.transitous.org");
    const [suggestion] = await motisGeocodingService.autocomplete("bushof", "de");
    const [result] = await motisGeocodingService.geocode("bushof", "de");
    expect(suggestion?.sourceIds).toEqual(["transitous"]);
    expect(result?.sourceIds).toEqual(["transitous"]);
  });

  it("credits Transitous when the local MOTIS is unreachable", async () => {
    setMotisLocalUrl("http://motis:8080");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const [result] = await motisGeocodingService.autocomplete("bushof", "de");
    expect(result?.sourceIds).toEqual(["transitous"]);
  });
});
