import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DATA_DIR = join(__dirname, "..", "data");

describe("vendored timezone boundaries", () => {
  const raw = readFileSync(join(DATA_DIR, "timezones.simplified.json"));
  const fc = JSON.parse(raw.toString("utf8")) as {
    features: { properties: { tzid: string }; geometry: { type: string } }[];
  };

  it("stays within the size budget", () => {
    expect(raw.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("carries a platform-resolvable tzid on every feature", () => {
    // timezone-boundary-builder dissolves zones that share identical current
    // UTC/DST rules into one combined polygon, so the with-oceans-now release
    // ships ~64 features rather than one per IANA zone id — 50 gives headroom
    // for that count shifting a little release to release.
    expect(fc.features.length).toBeGreaterThan(50);
    for (const feature of fc.features) {
      expect(feature.properties.tzid).toBeTruthy();
      expect(
        () => new Intl.DateTimeFormat("en-US", { timeZone: feature.properties.tzid }),
      ).not.toThrow();
    }
  });

  it("contains only polygonal geometry", () => {
    for (const feature of fc.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(feature.geometry.type);
    }
  });

  it("records provenance", () => {
    const meta = JSON.parse(readFileSync(join(DATA_DIR, "timezones.meta.json"), "utf8"));
    expect(meta.release).toBeTruthy();
    expect(meta.featureCount).toBe(fc.features.length);
  });
});
