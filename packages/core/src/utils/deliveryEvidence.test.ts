import { describe, expect, it } from "vitest";
import type { DeliveryProviderInfo } from "../types/delivery";
import type { Place } from "../types/place";
import { buildDeliveryOptions, classifyDeliveryUrl, resolveOsmOrderUrl } from "./deliveryEvidence";

const providers: DeliveryProviderInfo[] = [
  {
    id: "ubereats",
    name: "Uber Eats",
    domain: "ubereats.com",
    homepage: "https://ubereats.com",
    color: "#000",
    linkKind: "search",
  },
  {
    id: "wolt",
    name: "Wolt",
    domain: "wolt.com",
    homepage: "https://wolt.com",
    color: "#000",
    linkKind: "search",
  },
  {
    id: "lieferando",
    name: "Lieferando",
    domain: "lieferando.de",
    homepage: "https://lieferando.de",
    color: "#000",
    linkKind: "browse",
  },
];

function place(osmTags: Record<string, string> = {}, website?: string): Place {
  return {
    id: "osm:node:1",
    ids: { osm: "node:1" },
    primaryScheme: "osm",
    name: "Test",
    address: "Aachen",
    coordinates: [6.08, 50.77],
    osmTags,
    website,
  };
}

describe("delivery evidence", () => {
  it("strictly classifies exact German provider URLs", () => {
    expect(classifyDeliveryUrl("wolt.com/en/deu/aachen/restaurant/maher")).toMatchObject({
      providerId: "wolt",
      linkKind: "exact",
    });
    expect(
      classifyDeliveryUrl("https://lieferando.de/speisekarte/sultans-of-kebap-aachen"),
    ).toMatchObject({ providerId: "lieferando", linkKind: "exact" });
    expect(classifyDeliveryUrl("https://wolt.com.evil.example/restaurant/a")).toBeNull();
    expect(classifyDeliveryUrl("https://wolt.com:8443/restaurant/a")).toBeNull();
  });

  it("promotes an exact contributed URL", () => {
    const options = buildDeliveryOptions(
      place({
        delivery: "yes",
        "contact:website": "https://wolt.com/en/deu/aachen/restaurant/maher",
      }),
      providers,
    );
    expect(options[0]).toMatchObject({
      id: "wolt",
      linkKind: "exact",
      availability: "confirmed",
      evidence: "provider-url",
    });
  });

  it("normalizes partner spelling without inferring other platforms", () => {
    const options = buildDeliveryOptions(
      place({ "delivery:partner": "Uber Eats; WOLT" }),
      providers,
    );
    expect(
      options.filter((option) => option.availability === "confirmed").map((option) => option.id),
    ).toEqual(["ubereats", "wolt"]);
  });

  it("suppresses unknown fallbacks for delivery=no but keeps contradictory exact evidence", () => {
    expect(buildDeliveryOptions(place({ delivery: "no" }), providers)).toEqual([]);
    const options = buildDeliveryOptions(
      place({
        delivery: "no",
        "delivery:website": "https://wolt.com/en/deu/aachen/restaurant/test",
      }),
      providers,
    );
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe("wolt");
  });

  it("lets exact evidence, but not a partner declaration, override delivery=no", () => {
    expect(
      buildDeliveryOptions(place({ delivery: "no", "delivery:partner": "Wolt" }), providers),
    ).toEqual([]);
    const resolved = providers.map((provider) =>
      provider.id === "ubereats"
        ? { ...provider, linkKind: "exact" as const, url: "https://ubereats.com/de/store/test/id" }
        : provider,
    );
    expect(
      buildDeliveryOptions(place({ delivery: "no" }), resolved).map((option) => option.id),
    ).toEqual(["ubereats"]);
  });

  it("keeps delivery-specific provider URL precedence over a generic website", () => {
    const options = buildDeliveryOptions(
      place(
        { "delivery:website": "https://wolt.com/en/deu/aachen/restaurant/preferred" },
        "https://wolt.com/en/deu/aachen/restaurant/generic",
      ),
      providers,
    );
    expect(options[0].url).toContain("/preferred");
  });

  it("returns explicit first-party OSM ordering URLs", () => {
    expect(resolveOsmOrderUrl(place({ "website:orders": "restaurant.example/order" }))).toBe(
      "https://restaurant.example/order",
    );
    expect(
      resolveOsmOrderUrl(
        place({ "website:orders": "https://wolt.com/en/deu/aachen/restaurant/x" }),
      ),
    ).toBeNull();
  });

  it("keeps missing delivery evidence unknown", () => {
    expect(buildDeliveryOptions(place(), providers).map((option) => option.availability)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
  });
});
