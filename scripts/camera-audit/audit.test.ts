import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditCameraSnapshot } from "./audit.ts";

const options = {
  source: "https://overpass.private.coffee/api/interpreter",
  capturedAt: "2026-10-07T01:30:00Z",
  bbox: [6.04, 50.75, 6.13, 50.8] as const,
};
const query = Buffer.from("bounded query");
const node = (id: number, tags: Record<string, string> = {}, lat = 50.78) => ({
  type: "node",
  id,
  version: 1,
  timestamp: "2026-05-23T14:38:24Z",
  lat,
  lon: 6.1,
  tags,
});
const conflictTags: Record<string, string>[] = [
  { disused: "yes" },
  { removed: "yes" },
  { "disused:man_made": "surveillance" },
  { highway: "speed_camera" },
  { "contact:webcam": "https://example.org" },
  { "camera:type": "dome" },
  { "camera:type": "PTZ" },
  { "camera:type": "panning" },
  { "razed:man_made": "surveillance" },
  { "construction:man_made": "surveillance" },
  { "proposed:man_made": "surveillance" },
];
const alpr = { man_made: "surveillance", "surveillance:type": "ALPR" };
const raw = (elements: unknown[], extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({ osm3s: { timestamp_osm_base: "2026-07-28T02:16:18Z" }, elements, ...extra }),
  );

describe("bounded offline camera audit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T02:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("exports explicit multi-direction ALPR with unverified reality and source provenance", () => {
    const input = raw([node(1, { ...alpr, direction: "270;90", "surveillance:zone": "parking" })]);
    const { audit, geojson } = auditCameraSnapshot(input, query, options);
    expect(audit.decisions).toEqual({
      awarenessPrototype: "go",
      productionAwareness: "no-go",
      routeAvoidance: "no-go",
    });
    expect(audit.inputSha256).toBe(createHash("sha256").update(input).digest("hex"));
    expect(audit.querySha256).toBe(createHash("sha256").update(query).digest("hex"));
    expect(audit.snapshotAgeDays).toBeGreaterThan(70);
    expect(geojson.features).toHaveLength(1);
    expect(geojson.features[0]?.properties).toMatchObject({
      directions: [270, 90],
      directionStatus: "multiple",
      zone: "parking",
      physicalPresence: "unknown",
      position: "unverified",
      objectEditedAt: "2026-05-23T14:38:24Z",
      version: 1,
    });
    expect(geojson.attribution).toContain("OpenStreetMap contributors");
    expect(geojson.license).toBe("ODbL-1.0");
  });
  it("keeps speed cameras, webcams and CCTV separate and does not infer ALPR", () => {
    const { audit, geojson } = auditCameraSnapshot(
      raw([
        node(1, { highway: "speed_camera" }),
        node(2, { man_made: "surveillance", "surveillance:type": "webcam" }),
        node(3, { man_made: "surveillance", "surveillance:type": "camera" }),
        node(4, { man_made: "surveillance" }),
      ]),
      query,
      options,
    );
    expect(audit.counts).toMatchObject({
      speedCamera: 1,
      webcam: 1,
      otherSurveillance: 2,
      explicitAlpr: 0,
      eligible: 0,
    });
    expect(audit.decisions.awarenessPrototype).toBe("no-go");
    expect(geojson.features).toEqual([]);
  });
  it.each(conflictTags)("excludes unavailable or contradictory ALPR: %j", (tags) => {
    const { audit, geojson } = auditCameraSnapshot(
      raw([node(1, { ...alpr, ...tags })]),
      query,
      options,
    );
    expect(audit.counts.explicitAlpr).toBe(1);
    expect(geojson.features).toEqual([]);
    expect(audit.decisions.awarenessPrototype).toBe("no-go");
  });
  it.each([undefined, "nonsense", "90;nonsense", "-20", "361"])(
    "does not invent direction for %s",
    (direction) => {
      const tags = { ...alpr, ...(direction === undefined ? {} : { direction }) };
      const r = auditCameraSnapshot(raw([node(1, tags)]), query, options);
      expect(r.geojson.features[0]?.properties.directionStatus).toBe("unknown");
      expect(r.geojson.features[0]?.properties.directions).toEqual([]);
    },
  );
  it("handles compass points and flags conflicting preferred/legacy directions", () => {
    const r = auditCameraSnapshot(
      raw([
        node(1, { ...alpr, direction: "NNE;360" }),
        node(2, { ...alpr, direction: "90", "camera:direction": "180" }),
      ]),
      query,
      options,
    );
    expect(r.geojson.features[0]?.properties.directions).toEqual([22.5, 0]);
    expect(r.geojson.features[1]?.properties.directionStatus).toBe("conflicting");
    expect(r.geojson.features[1]?.properties.directions).toEqual([]);
  });
  it("flags nearby distinct objects without merging devices", () => {
    const r = auditCameraSnapshot(raw([node(1, alpr), node(2, alpr, 50.78001)]), query, options);
    expect(r.geojson.features).toHaveLength(2);
    expect(r.audit.nearbyPairs).toHaveLength(1);
    expect(r.audit.nearbyPairs[0]?.identities).toEqual(["node/1", "node/2"]);
  });
  it("ties manual exclusion to a matching object version", () => {
    const review = [
      {
        identity: "node/1",
        version: 1,
        decision: "exclude" as const,
        reason: "actual position unknown in source note",
      },
    ];
    const r = auditCameraSnapshot(raw([node(1, alpr)]), query, { ...options, review });
    expect(r.audit.rows[0]).toMatchObject({ disposition: "excluded", reason: review[0]?.reason });
    expect(r.geojson.features).toHaveLength(0);
    expect(() =>
      auditCameraSnapshot(raw([node(1, alpr)]), query, {
        ...options,
        review: [{ ...review[0], version: 2 }],
      }),
    ).toThrow(/review/i);
    expect(() => auditCameraSnapshot(raw([]), query, { ...options, review })).toThrow(/review/i);
  });
  it("never treats an Overpass partial response as empty coverage", () => {
    expect(() =>
      auditCameraSnapshot(raw([], { remark: "runtime error: timed out" }), query, options),
    ).toThrow(/complete/i);
  });
  it.each([
    {},
    { elements: "bad" },
    { osm3s: { timestamp_osm_base: "2027-01-01T00:00:00Z" }, elements: [] },
    { osm3s: { timestamp_osm_base: "bad" }, elements: [] },
  ])("rejects malformed acquisition %j", (input) => {
    expect(() => auditCameraSnapshot(Buffer.from(JSON.stringify(input)), query, options)).toThrow();
  });
  it.each([
    node(1, alpr, 91),
    { ...node(1, alpr), lon: 8 },
    { ...node(1, alpr), version: 0 },
    { ...node(1, alpr), timestamp: "future" },
    { ...node(1, alpr), timestamp: "2027-01-01T00:00:00Z" },
    { ...node(1, alpr), tags: { direction: 42 } },
  ])("rejects invalid object without a no-go claim", (item) => {
    expect(() => auditCameraSnapshot(raw([item]), query, options)).toThrow();
  });
  it("rejects duplicate identity, oversized snapshot and broad/invalid bounds", () => {
    expect(() => auditCameraSnapshot(raw([node(1), node(1)]), query, options)).toThrow(
      /duplicate/i,
    );
    expect(() => auditCameraSnapshot(Buffer.alloc(5242881), query, options)).toThrow(/size/i);
    for (const bbox of [
      [6, 50, 9, 51],
      [6, 51, 6, 52],
      [6, 50, 7, Infinity],
    ])
      expect(() =>
        auditCameraSnapshot(raw([]), query, {
          ...options,
          bbox: bbox as [number, number, number, number],
        }),
      ).toThrow(/bbox/i);
  });
  it.each([
    "https://user:secret@example.org",
    "https://example.org?key=secret",
    "file:///tmp/input",
  ])("rejects credential or non-HTTP source without echoing it", (source) => {
    expect(() => auditCameraSnapshot(raw([]), query, { ...options, source })).toThrow(
      "Invalid source URL",
    );
  });
  it("rejects calendar-normalized dates instead of silently accepting February30", () => {
    expect(() =>
      auditCameraSnapshot(
        raw([{ ...node(1, alpr), timestamp: "2026-02-30T00:00:00Z" }]),
        query,
        options,
      ),
    ).toThrow(/timestamp/i);
  });
  it("bounds the ALPR audit and duplicate candidate list without merging", () => {
    expect(() =>
      auditCameraSnapshot(
        raw(Array.from({ length: 1001 }, (_, i) => node(i + 1, alpr))),
        query,
        options,
      ),
    ).toThrow(/ALPR limit/i);
    const r = auditCameraSnapshot(
      raw(Array.from({ length: 50 }, (_, i) => node(i + 1, alpr))),
      query,
      options,
    );
    expect(r.geojson.features).toHaveLength(50);
    expect(r.audit.nearbyPairs).toHaveLength(1000);
    expect(r.audit.nearbyPairsTruncated).toBe(true);
  });
});
