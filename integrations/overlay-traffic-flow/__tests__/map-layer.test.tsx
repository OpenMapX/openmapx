import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap, render } from "@/test";
import { useTrafficFlowStore } from "../store";

let fake: FakeMap;

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ martinBaseUrl: "https://api.test/martin" }),
}));

import { TrafficFlowLayer } from "../map-layer";

const SRC = "omx-traffic-flow-src";
const CASING = "omx-traffic-flow-casing";
const COLOR = "omx-traffic-flow-color";

const COLOR_EXPR = [
  "interpolate",
  ["linear"],
  ["coalesce", ["get", "speed_ratio"], 1],
  0.0,
  "#7e0023",
  0.25,
  "#e8112d",
  0.5,
  "#ff8c00",
  0.75,
  "#ffd500",
  1.0,
  "#2ecc40",
];

beforeEach(() => {
  fake = createFakeMap();
  useTrafficFlowStore.setState({ panelOpen: false, layerVisible: false });
});

describe("TrafficFlowLayer", () => {
  it("does not register the source/layers while hidden", () => {
    render(<TrafficFlowLayer />);

    expect(fake.state.sources.has(SRC)).toBe(false);
    expect(fake.state.layers.has(COLOR)).toBe(false);
    expect(fake.state.layers.has(CASING)).toBe(false);
  });

  it("registers a vector source plus casing + color line layers when visible", () => {
    useTrafficFlowStore.setState({ panelOpen: true, layerVisible: true });
    render(<TrafficFlowLayer />);

    const source = fake.state.sources.get(SRC);
    expect(source?.type).toBe("vector");
    expect(source?.tiles).toEqual(["https://api.test/martin/segment_flow/{z}/{x}/{y}"]);

    const casing = fake.state.layers.get(CASING);
    expect(casing?.type).toBe("line");
    expect(casing?.source).toBe(SRC);
    expect(casing?.["source-layer"]).toBe("segment_flow");

    const color = fake.state.layers.get(COLOR);
    expect(color?.type).toBe("line");
    expect(color?.source).toBe(SRC);
    expect(color?.["source-layer"]).toBe("segment_flow");

    const paint = color?.paint as Record<string, unknown>;
    expect(paint["line-color"]).toEqual(COLOR_EXPR);
  });
});
