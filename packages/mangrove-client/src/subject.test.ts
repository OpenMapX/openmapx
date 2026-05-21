import { describe, expect, it } from "vitest";
import {
  buildMangroveQueryUri,
  buildMangroveSubjectUri,
  haversineDistanceMeters,
  normalizeMangrovePlaceName,
  normalizeOsmElementRef,
  parseMangroveGeoUri,
  REVIEW_MATCH_MAX_DISTANCE_METERS,
} from "./subject";

describe("buildMangroveSubjectUri", () => {
  it("encodes name and pins precision/uncertainty for submit identity", () => {
    const uri = buildMangroveSubjectUri({
      lat: 50.7753,
      lng: 6.0839,
      name: "McDonald's",
    });
    expect(uri).toBe("geo:50.775300,6.083900?q=McDonald's&u=30");
  });
});

describe("buildMangroveQueryUri", () => {
  it("omits q= so Mangrove's name-OR clause cannot bleed in worldwide matches", () => {
    const uri = buildMangroveQueryUri({ lat: 50.7753, lng: 6.0839 });
    expect(uri).not.toMatch(/q=/);
    expect(uri).toBe("geo:50.775300,6.083900?u=100");
  });
});

describe("parseMangroveGeoUri", () => {
  it("parses Android-style ? separator", () => {
    expect(parseMangroveGeoUri("geo:50.775300,6.083900?q=McDonald%27s&u=30")).toEqual({
      lat: 50.7753,
      lng: 6.0839,
      name: "McDonald's",
      uncertainty: 30,
    });
  });

  it("parses RFC 5870 ; separator", () => {
    expect(parseMangroveGeoUri("geo:48.85,2.35;u=15")).toEqual({
      lat: 48.85,
      lng: 2.35,
      uncertainty: 15,
    });
  });

  it("returns null for non-geo schemes", () => {
    expect(parseMangroveGeoUri("urn:maresi:abc")).toBeNull();
    expect(parseMangroveGeoUri("https://example.com")).toBeNull();
  });

  it("returns null for malformed coords", () => {
    expect(parseMangroveGeoUri("geo:not-a-number,6.08")).toBeNull();
  });
});

describe("normalizeOsmElementRef", () => {
  it("normalizes supported OSM refs and drops version suffixes", () => {
    expect(normalizeOsmElementRef("osm:Node/4506022549/7")).toBe("node/4506022549");
    expect(normalizeOsmElementRef("way/123")).toBe("way/123");
    expect(normalizeOsmElementRef("relation/456/3")).toBe("relation/456");
  });

  it("rejects malformed refs", () => {
    expect(normalizeOsmElementRef("n4506022549")).toBeUndefined();
    expect(normalizeOsmElementRef("node/not-a-number")).toBeUndefined();
  });
});

describe("normalizeMangrovePlaceName", () => {
  it("normalizes accents, apostrophes and punctuation for exact equality", () => {
    expect(normalizeMangrovePlaceName("Caffè Milano")).toBe("caffe milano");
    expect(normalizeMangrovePlaceName("McDonald's")).toBe("mcdonalds");
  });

  it("keeps different nearby POI names distinct", () => {
    expect(normalizeMangrovePlaceName("Zahnärzte am Klenkes")).not.toBe(
      normalizeMangrovePlaceName("Frittenwerk"),
    );
  });
});

describe("haversineDistanceMeters", () => {
  it("returns 0 for identical points", () => {
    expect(haversineDistanceMeters({ lat: 50, lng: 6 }, { lat: 50, lng: 6 })).toBe(0);
  });

  it("rejects far-apart McDonald's branches at the configured tolerance", () => {
    // Aachen vs Tokyo McDonald's — must be way past the matching threshold.
    const aachen = { lat: 50.7753, lng: 6.0839 };
    const tokyo = { lat: 35.6762, lng: 139.6503 };
    const dist = haversineDistanceMeters(aachen, tokyo);
    expect(dist).toBeGreaterThan(REVIEW_MATCH_MAX_DISTANCE_METERS);
    expect(dist).toBeGreaterThan(9_000_000);
  });

  it("matches reviews within ~30m of the queried place", () => {
    // 30 meters north of Aachen reference — same building footprint.
    const place = { lat: 50.7753, lng: 6.0839 };
    const nearby = { lat: 50.7753 + 30 / 111_320, lng: 6.0839 };
    const dist = haversineDistanceMeters(place, nearby);
    expect(dist).toBeLessThan(REVIEW_MATCH_MAX_DISTANCE_METERS);
    expect(dist).toBeGreaterThan(25);
    expect(dist).toBeLessThan(35);
  });
});
