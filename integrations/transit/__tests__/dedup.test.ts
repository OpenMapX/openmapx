import type { TransitStop } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ distances: 0 }));
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    haversineMeters: (...args: Parameters<typeof actual.haversineMeters>) => {
      counts.distances++;
      return actual.haversineMeters(...args);
    },
  };
});

import { deduplicateStops, diceSimilarity, haversineMeters, normalizeName } from "../dedup";

const stop = (id: string, lat: number, lng: number, name = "Central Market", provider = "a") =>
  ({ id, lat, lng, name, provider }) as TransitStop;

// Independent all-pairs reference preserves the pre-index clustering contract.
function legacy(stops: TransitStop[], priority: (provider: string) => number = () => 10) {
  const sorted = [...stops].sort((a, b) => priority(a.provider) - priority(b.provider));
  const parents = sorted.map((_, i) => i);
  const root = (i: number): number => (parents[i] === i ? i : root(parents[i]));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (haversineMeters(sorted[i].lat, sorted[i].lng, sorted[j].lat, sorted[j].lng) > 300)
        continue;
      if (diceSimilarity(normalizeName(sorted[i].name), normalizeName(sorted[j].name)) < 0.5)
        continue;
      const a = root(i),
        b = root(j);
      parents[Math.max(a, b)] = Math.min(a, b);
    }
  }
  return sorted.filter((_, i) => root(i) === i);
}

beforeEach(() => {
  counts.distances = 0;
});

describe("spatial stop clustering", () => {
  it("keeps sparse distance work bounded instead of checking every pair", () => {
    const stops = Array.from({ length: 2_000 }, (_, i) =>
      stop(String(i), -80 + i * 0.08, i % 2 ? 10 : 0),
    );
    expect(deduplicateStops(stops)).toEqual(stops);
    expect(counts.distances).toBeLessThan(stops.length * 4);
  });

  it("matches all-pairs clustering across seeded dense and sparse fixtures", () => {
    let seed = 42;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const priority = (p: string) => (p === "b" ? 1 : 10);
    for (const lat of [0, 50, 89.99, -89.99]) {
      const stops = Array.from({ length: 200 }, (_, i) =>
        stop(
          String(i),
          Math.max(-90, Math.min(90, lat + (random() - 0.5) * 0.025)),
          (random() - 0.5) * 0.05,
          i % 3 ? "Market Bahnhof" : "Airport",
          i % 2 ? "a" : "b",
        ),
      );
      expect(deduplicateStops(stops, priority)).toEqual(legacy(stops, priority));
    }
  });

  it("preserves transitive clusters, stable ties and provider priority", () => {
    const stops = [
      stop("a", 0, 0),
      stop("b", 0, 0.002, "Market Station", "b"),
      stop("c", 0, 0.004),
    ];
    expect(deduplicateStops(stops).map((s) => s.id)).toEqual(["a"]);
    expect(deduplicateStops(stops, (p) => (p === "b" ? 1 : 10)).map((s) => s.id)).toEqual(["b"]);
  });

  it("matches threshold, coincident, polar, antimeridian and invalid-coordinate cases", () => {
    const radiusDegrees = ((300 / 6_371_000) * 180) / Math.PI;
    const fixtures = [
      [
        stop("a", 0, 0),
        stop("b", radiusDegrees * (1 - 1e-8), 0),
        stop("c", radiusDegrees * (2 + 1e-8), 0),
      ],
      [stop("a", 0, 179.999), stop("b", 0, -179.999)],
      [stop("a", 89.999, 0), stop("b", 89.999, 180)],
      [stop("a", 50, 6), stop("b", 50, 6), stop("c", 50, 6, "Airport")],
      [stop("a", Number.NaN, 0), stop("b", 50, 6), stop("c", 0, 0)],
    ];
    for (const stops of fixtures) expect(deduplicateStops(stops)).toEqual(legacy(stops));
  });
});
