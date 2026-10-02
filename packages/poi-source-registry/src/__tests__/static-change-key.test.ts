import { describe, expect, it } from "vitest";
import { createStaticPoiChangeKey } from "../static-change-key.js";
import type { PoiRow } from "../types.js";

const rows: PoiRow[] = [
  { poiId: "b", lng: 7, lat: 51, payload: { name: "B", nested: { a: 1, z: 2 } } },
  { poiId: "a", lng: 6, lat: 50, payload: { connectors: ["CCS", "Type2"] } },
];

describe("static POI change key", () => {
  it("ignores row order and nested object property order without mutating rows", () => {
    const before = JSON.stringify(rows);
    const key = createStaticPoiChangeKey("v1");
    expect(key(rows)).toBe(
      key([rows[1], { ...rows[0], payload: { nested: { z: 2, a: 1 }, name: "B" } }]),
    );
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each([
    { poiId: "renamed" },
    { lng: 7.01 },
    { lat: 51.01 },
    { payload: { name: "changed" } },
    { payload: { name: "B", nested: { a: 1, z: 3 } } },
  ])("detects full row changes: %j", (patch) => {
    const key = createStaticPoiChangeKey("v1");
    expect(key([{ ...rows[0], ...patch }, rows[1]])).not.toBe(key(rows));
  });

  it("retains array ordering and distinguishes comparison versions", () => {
    const key = createStaticPoiChangeKey("v1");
    expect(key([rows[0], { ...rows[1], payload: { connectors: ["Type2", "CCS"] } }])).not.toBe(
      key(rows),
    );
    expect(createStaticPoiChangeKey("v2")(rows)).not.toBe(key(rows));
  });

  it("compares JSON-equivalent payloads as they are stored", () => {
    const key = createStaticPoiChangeKey("v1");
    expect(
      key([
        {
          ...rows[0],
          payload: {
            optional: undefined,
            date: new Date("2026-01-01T00:00:00Z"),
            values: [undefined, NaN],
          },
        },
      ]),
    ).toBe(
      key([{ ...rows[0], payload: { date: "2026-01-01T00:00:00.000Z", values: [null, null] } }]),
    );
    expect(key([{ ...rows[0], payload: JSON.parse('{"__proto__":{"v":1}}') }])).not.toBe(
      key([{ ...rows[0], payload: {} }]),
    );
  });

  it("serializes contextual toJSON payloads at the same root as persistence", () => {
    const payload = (tariff: number) => ({
      toJSON(key: string) {
        return { tariff: key === "" ? tariff : 0 };
      },
    });
    const first = { ...rows[0], payload: payload(1) };
    const changed = { ...rows[0], payload: payload(2) };
    const key = createStaticPoiChangeKey("v1");

    expect(JSON.stringify(first.payload)).toBe('{"tariff":1}');
    expect(JSON.stringify(changed.payload)).toBe('{"tariff":2}');
    expect(key([first])).toBe(key([{ ...rows[0], payload: { tariff: 1 } }]));
    expect(key([changed])).not.toBe(key([first]));
  });
});
