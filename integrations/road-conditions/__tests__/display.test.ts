import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoadConditionEvent } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { buildRoadConditionDisplayGroups, buildRoadConditionDisplayLines } from "../display";

const DISPLAY_SOURCE_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, "");

function event(
  id: string,
  geometry: RoadConditionEvent["geometry"],
  extra: Partial<RoadConditionEvent> = {},
): RoadConditionEvent {
  return {
    id,
    source: "source-a",
    provider: "road-conditions-openconditions",
    type: "roadworks",
    severity: "medium",
    headline: "Roadworks",
    geometry,
    ...extra,
  };
}

describe("buildRoadConditionDisplayGroups", () => {
  it("uses source-resolvable local imports for the production bundler", () => {
    const source = readFileSync(resolve(DISPLAY_SOURCE_DIR, "display.ts"), "utf8");
    const localImports = [...source.matchAll(/from\s+["'](\.[^"']+)["']/g)].map(
      ([, specifier]) => specifier,
    );

    expect(localImports.length).toBeGreaterThan(0);
    for (const specifier of localImports) {
      const candidate = resolve(DISPLAY_SOURCE_DIR, specifier ?? "");
      const hasSourceFile = /\.[a-z]+$/i.test(specifier ?? "")
        ? existsSync(candidate)
        : [".ts", ".tsx", ".js", ".jsx"].some((extension) =>
            existsSync(`${candidate}${extension}`),
          );
      expect(hasSourceFile, `unresolvable local import: ${specifier}`).toBe(true);
    }
  });

  it("combines explicitly grouped line records into one line and one representative marker", () => {
    const events = [
      event(
        "oc:1",
        {
          type: "LineString",
          coordinates: [
            [6.77, 51.2],
            [6.771, 51.2],
          ],
        },
        { groupId: "works-42" },
      ),
      event(
        "oc:2",
        {
          type: "LineString",
          coordinates: [
            [6.771, 51.2],
            [6.772, 51.2],
          ],
        },
        { groupId: "works-42" },
      ),
      event(
        "oc:3",
        {
          type: "LineString",
          coordinates: [
            [6.772, 51.2],
            [6.773, 51.2],
          ],
        },
        { groupId: "works-42" },
      ),
    ];

    const [group] = buildRoadConditionDisplayGroups(events);

    expect(group).toMatchObject({
      displayId: "group:road-conditions-openconditions:source-a:works-42",
      events,
      markerCoordinates: [expect.any(Array)],
      representativeCoordinate: expect.any(Array),
    });
    expect(group?.lineGeometry).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [6.77, 51.2],
          [6.771, 51.2],
        ],
        [
          [6.771, 51.2],
          [6.772, 51.2],
        ],
        [
          [6.772, 51.2],
          [6.773, 51.2],
        ],
      ],
    });
    expect(group?.markerCoordinates).toHaveLength(1);
  });

  it("deduplicates identical grouped line components but keeps every source record", () => {
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [6.773093, 51.204357],
        [6.773365, 51.204536],
        [6.7736983, 51.204826],
      ],
    };
    const events = [
      event("oc:roadworks", geometry, {
        groupId: "works-duplicate",
        type: "roadworks",
        severity: "low",
      }),
      event("oc:other", geometry, {
        groupId: "works-duplicate",
        type: "other",
        severity: "unknown",
      }),
    ];

    const [group] = buildRoadConditionDisplayGroups(events);

    expect(group?.events).toEqual(events);
    expect(group?.lineGeometry).toEqual({
      type: "MultiLineString",
      coordinates: [geometry.coordinates],
    });
  });

  it("keeps different provider/source/group identities separate", () => {
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [6.77, 51.2],
        [6.771, 51.2],
      ],
    };
    const groups = buildRoadConditionDisplayGroups([
      event("oc:source-a", geometry, { groupId: "same" }),
      event("oc:other", geometry, { source: "other-source", groupId: "same" }),
      event("other-provider", geometry, { provider: "other-provider", groupId: "same" }),
      event("oc:separate", geometry, { groupId: "different" }),
    ]);

    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.events.map((item) => item.id))).toEqual([
      ["oc:source-a"],
      ["oc:other"],
      ["other-provider"],
      ["oc:separate"],
    ]);
  });

  it("does not infer relationships from similar records without an explicit group id", () => {
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [6.77, 51.2],
        [6.771, 51.2],
      ],
    };
    const groups = buildRoadConditionDisplayGroups([
      event("oc:a", geometry, { headline: "Same date" }),
      event("oc:b", geometry, { headline: "Same date" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.displayId)).toEqual(["event:oc:a", "event:oc:b"]);
  });

  it("keeps MultiPoint roadwork endpoints as markers and never synthesizes a line", () => {
    const points = [
      [6.77, 51.2],
      [6.78, 51.2],
    ] as [number, number][];
    const [group] = buildRoadConditionDisplayGroups([
      event("oc:endpoints", { type: "MultiPoint", coordinates: points }, { groupId: "ends" }),
    ]);

    expect(group?.lineGeometry).toBeUndefined();
    expect(group?.markerCoordinates).toEqual(points);
    expect(group?.representativeCoordinate).toEqual(points[0]);
  });

  it("does not guess that a long ungrouped MultiPoint is a path", () => {
    const points = Array.from(
      { length: 5 },
      (_, index) => [6.77 + index * 0.001, 51.2] as [number, number],
    );
    const [group] = buildRoadConditionDisplayGroups([
      event("oc:long-endpoints", { type: "MultiPoint", coordinates: points }),
    ]);

    expect(group?.lineGeometry).toBeUndefined();
    expect(group?.markerCoordinates).toEqual(points);
  });

  it("preserves all members of a source MultiLineString", () => {
    const geometry = {
      type: "MultiLineString" as const,
      coordinates: [
        [
          [6.77, 51.2],
          [6.771, 51.2],
        ],
        [
          [6.78, 51.2],
          [6.781, 51.2],
        ],
      ],
    };
    const [group] = buildRoadConditionDisplayGroups([event("oc:multi", geometry)]);

    expect(group?.lineGeometry).toEqual(geometry);
    expect(group?.markerCoordinates).toHaveLength(1);
  });

  it("deduplicates repeated members inside a source MultiLineString", () => {
    const repeated = [
      [6.77, 51.2],
      [6.771, 51.2],
    ];
    const distinct = [
      [6.78, 51.2],
      [6.781, 51.2],
    ];
    const geometry = {
      type: "MultiLineString" as const,
      coordinates: [repeated, repeated, distinct],
    };

    const [group] = buildRoadConditionDisplayGroups([event("oc:multi-duplicate", geometry)]);

    expect(group?.lineGeometry).toEqual({
      type: "MultiLineString",
      coordinates: [repeated, distinct],
    });
  });

  it("renders an exact line overlap once while retaining every display group id", () => {
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [6.7766986, 51.215633],
        [6.775376, 51.215633],
      ],
    };
    const groups = buildRoadConditionDisplayGroups([
      event("oc:congestion", geometry, {
        groupId: "congestion-group",
        type: "congestion",
        severity: "medium",
      }),
      event("oc:roadworks", geometry, {
        groupId: "roadworks-group",
        type: "roadworks",
        severity: "low",
      }),
    ]);

    expect(buildRoadConditionDisplayLines(groups)).toEqual([
      {
        geometry,
        displayIds: [
          "group:road-conditions-openconditions:source-a:congestion-group",
          "group:road-conditions-openconditions:source-a:roadworks-group",
        ],
      },
    ]);
  });

  it("keeps opposite-direction line components separate", () => {
    const forward = {
      type: "LineString" as const,
      coordinates: [
        [6.77, 51.2],
        [6.78, 51.2],
      ],
    };
    const reverse = {
      type: "LineString" as const,
      coordinates: [...forward.coordinates].reverse(),
    };
    const groups = buildRoadConditionDisplayGroups([
      event("oc:forward", forward, { groupId: "forward" }),
      event("oc:reverse", reverse, { groupId: "reverse" }),
    ]);

    expect(buildRoadConditionDisplayLines(groups)).toHaveLength(2);
  });
});
