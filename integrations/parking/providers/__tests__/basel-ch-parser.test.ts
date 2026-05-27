import { describe, expect, it } from "vitest";
import { parseBaselChBundled } from "../basel-ch-parser.js";

/**
 * Focused regression test for the time-series dedup added after we
 * discovered Basel's upstream is a ~1M-record snapshot history of ~17
 * facilities. The poi-source URL passes `order_by=published desc&limit=200`
 * so the parser sees newest-first; the dedup keeps only the first row per
 * `id2`. Without dedup the staging-table primary key would reject the
 * batch on the second occurrence of any id2.
 */

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop };
const ctx = { log };

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), "utf-8");
}

describe("parseBaselChBundled — time-series dedup", () => {
  it("emits one row per id2, keeping the newest record (first in input)", async () => {
    const fixture = {
      total_count: 978_957,
      results: [
        // Newest snapshot for storchen — must win.
        {
          published: "2026-05-27T15:00:37+00:00",
          free: 12,
          total: 142,
          auslastungen: 91,
          id: "baselparkhausstorchen",
          id2: "storchen",
          title: "Parkhaus Storchen",
          name: "Storchen",
          address: "Fischmarkt 10",
          link: null,
          geo_point_2d: { lon: 7.58658, lat: 47.5592347 },
          description: null,
        },
        // Newest for city.
        {
          published: "2026-05-27T15:00:37+00:00",
          free: 50,
          total: 500,
          auslastungen: 90,
          id: "baselparkhauscity",
          id2: "city",
          title: "Parkhaus City",
          name: "City",
          address: "Steinenberg",
          link: null,
          geo_point_2d: { lon: 7.585, lat: 47.555 },
          description: null,
        },
        // Older snapshot for storchen — must be ignored.
        {
          published: "2026-05-27T14:00:37+00:00",
          free: 8,
          total: 142,
          auslastungen: 94,
          id: "baselparkhausstorchen",
          id2: "storchen",
          title: "Parkhaus Storchen",
          name: "Storchen",
          address: "Fischmarkt 10",
          link: null,
          geo_point_2d: { lon: 7.58658, lat: 47.5592347 },
          description: null,
        },
      ],
    };

    const out = await parseBaselChBundled(buf(fixture), ctx);

    expect(out.static.map((r) => r.poiId).sort()).toEqual(["city", "storchen"]);
    // Live state must reflect the newer free count (12), not the older (8).
    expect(out.live.get("storchen")?.freeSpaces).toBe(12);
    expect(out.live.get("storchen")?.asOf).toBe("2026-05-27T15:00:37+00:00");
  });
});
