import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedIntegrationMeta } from "../../types/integrationMeta";
import { createOverlayStore } from "../createOverlayStore";
import {
  getOverlayEntry,
  initOverlayRegistry,
  integrationIdToOverlayId,
  OVERLAY_REGISTRY,
  toggleOverlay,
} from "../overlayRegistry";

function imagery(provider: "mapillary" | "panoramax"): LoadedIntegrationMeta {
  const id = `street-level-imagery-${provider}`;
  const manifest = JSON.parse(
    readFileSync(
      new URL(`../../../../../integrations/${id}/manifest.json`, import.meta.url),
      "utf8",
    ),
  ) as LoadedIntegrationMeta;
  return { ...manifest, name: id, enabled: true };
}

afterEach(() => initOverlayRegistry([]));

describe("initOverlayRegistry metadata refresh", () => {
  it("removes an integration overlay when refreshed metadata no longer includes it", () => {
    const id = "metadata-refresh-test";
    createOverlayStore({ overlayId: id, extra: {} });
    initOverlayRegistry([
      {
        id: `overlay-${id}`,
        name: "Refresh test",
        enabled: true,
        domains: ["map-overlay"],
        frontend: { overlay: {} },
      },
    ]);
    expect(getOverlayEntry(id)?.serviceId).toBe(`overlay-${id}`);

    initOverlayRegistry([]);

    expect(getOverlayEntry(id)).toBeUndefined();
  });

  it("preserves the air-quality overlay identity across the frontend ownership move", () => {
    expect(integrationIdToOverlayId("air-quality")).toBe("air-quality");
    expect(integrationIdToOverlayId("overlay-air-quality")).toBe("air-quality");
  });

  it("rejects two enabled frontend owners for one overlay identity", () => {
    expect(() =>
      initOverlayRegistry([
        {
          id: "air-quality",
          name: "Canonical air quality",
          enabled: true,
          domains: ["air-quality"],
          frontend: { overlay: {} },
        },
        {
          id: "overlay-air-quality",
          name: "Legacy OpenAQ",
          enabled: true,
          domains: ["air-quality"],
          frontend: { mapLayer: true },
        },
      ]),
    ).toThrow(/multiple enabled frontend owners.*air-quality/i);
  });
});

describe("shared overlay ownership", () => {
  it.each([
    { first: "mapillary", second: "panoramax", owner: "street-level-imagery-mapillary" },
    { first: "panoramax", second: "mapillary", owner: "street-level-imagery-panoramax" },
  ] as const)("registers one imagery overlay with $first first", ({ first, second, owner }) => {
    initOverlayRegistry([imagery(first), imagery(second)]);

    expect(OVERLAY_REGISTRY.map((entry) => entry.id)).toEqual(["street-level-imagery"]);
    expect(getOverlayEntry("street-level-imagery")?.serviceId).toBe(owner);
    expect(getOverlayEntry("street-level-imagery")?.excludes).toEqual([
      "air-quality",
      "earthquakes",
      "wildfires",
      "winter-sports",
      "hiking",
    ]);
  });

  it("preserves one overlay's state while its enabled providers change", () => {
    createOverlayStore({ overlayId: "street-level-imagery", extra: {} });
    initOverlayRegistry([imagery("mapillary"), imagery("panoramax")]);
    toggleOverlay("street-level-imagery", { kind: "user" });
    const state = getOverlayEntry("street-level-imagery")?.getState();

    initOverlayRegistry([imagery("panoramax")]);
    expect(OVERLAY_REGISTRY).toHaveLength(1);
    expect(getOverlayEntry("street-level-imagery")?.serviceId).toBe(
      "street-level-imagery-panoramax",
    );
    expect(getOverlayEntry("street-level-imagery")?.getState()).toBe(state);
    expect(state?.panelOpen).toBe(true);
    expect(state?.layerVisible).toBe(true);

    initOverlayRegistry([imagery("panoramax"), imagery("mapillary")]);
    expect(OVERLAY_REGISTRY).toHaveLength(1);
    expect(getOverlayEntry("street-level-imagery")?.getState()).toBe(state);

    initOverlayRegistry([]);
    expect(getOverlayEntry("street-level-imagery")).toBeUndefined();
  });

  it.each([
    { first: undefined, second: "street-level-imagery" },
    { first: "street-level-imagery", second: undefined },
    { first: "street-level-imagery", second: "another-layer" },
    { first: "", second: "" },
  ])("rejects unshared or mismatched owners: $first / $second", ({ first, second }) => {
    const a = imagery("mapillary");
    const b = imagery("panoramax");
    expect(() =>
      initOverlayRegistry([
        { ...a, frontend: { ...a.frontend, sharedMapLayer: first } },
        { ...b, frontend: { ...b.frontend, sharedMapLayer: second } },
      ]),
    ).toThrow(/multiple enabled frontend owners.*street-level-imagery/i);
  });

  it("rejects a third competing owner even after two legitimate shared owners", () => {
    const competing = imagery("panoramax");
    expect(() =>
      initOverlayRegistry([
        imagery("mapillary"),
        imagery("panoramax"),
        {
          ...competing,
          id: "street-level-imagery-other",
          frontend: { ...competing.frontend, sharedMapLayer: undefined },
        },
      ]),
    ).toThrow(/street-level-imagery-other/);
  });

  it("ignores disabled competing owners", () => {
    const disabled = imagery("mapillary");
    initOverlayRegistry([
      {
        ...disabled,
        enabled: false,
        frontend: { ...disabled.frontend, sharedMapLayer: undefined },
      },
      imagery("panoramax"),
    ]);
    expect(OVERLAY_REGISTRY.map((entry) => entry.serviceId)).toEqual([
      "street-level-imagery-panoramax",
    ]);
  });
});
