import type { Attribution } from "@openmapx/mobility-core/attribution";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const osm: Attribution = {
  sourceId: "openstreetmap",
  name: "© OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
};

const maptiler: Attribution = {
  sourceId: "maptiler",
  name: "© MapTiler",
  url: "https://www.maptiler.com/copyright/",
};

// Drive the strip with a controlled `entries` map by stubbing the store hook.
// The selector form `useMapAttributionStore((s) => s.entries)` makes a plain
// mock that returns the entries record straight back sufficient.
const entriesRef = { current: {} as Record<string, Attribution[]> };

vi.mock("@/lib/mapAttributionStore", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/mapAttributionStore")>(
    "../../../lib/mapAttributionStore",
  );
  return {
    ...actual,
    useMapAttributionStore: ((
      selector?: (s: { entries: Record<string, Attribution[]> }) => unknown,
    ) =>
      selector
        ? selector({ entries: entriesRef.current })
        : { entries: entriesRef.current }) as unknown,
  };
});

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useSidebarStore: (() => false) as unknown,
  };
});

import { MapAttributionStrip } from "../MapAttributionStrip";

describe("MapAttributionStrip", () => {
  it("renders nothing when no layers are registered", () => {
    entriesRef.current = {};
    const markup = renderToStaticMarkup(<MapAttributionStrip />);
    expect(markup).toBe("");
  });

  it("renders a chip per registered attribution", () => {
    entriesRef.current = { basemap: [maptiler, osm] };
    const markup = renderToStaticMarkup(<MapAttributionStrip />);
    expect(markup).toContain("MapTiler");
    expect(markup).toContain("OpenStreetMap");
    expect(markup).toContain('href="https://www.openstreetmap.org/copyright"');
  });

  it("deduplicates by sourceId across layers", () => {
    entriesRef.current = { basemap: [maptiler, osm], ev: [osm] };
    const markup = renderToStaticMarkup(<MapAttributionStrip />);
    expect(markup.match(/data-source-id="openstreetmap"/g)?.length).toBe(1);
    expect(markup.match(/data-source-id="maptiler"/g)?.length).toBe(1);
  });

  it("hides itself again once every layer's contribution has been removed", () => {
    entriesRef.current = {};
    const markup = renderToStaticMarkup(<MapAttributionStrip />);
    expect(markup).toBe("");
  });
});
