// @vitest-environment jsdom

import {
  createOverlayStore,
  getRegisteredOverlayStore,
  isOverlayActive,
  type OverlayStoreBase,
  registerOverlayEntry,
} from "@openmapx/core";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: true }),
}));

import { DeepLinkManager } from "./DeepLinkManager";

const FALLBACK: OverlayStoreBase = {
  panelOpen: false,
  layerVisible: false,
  userRevision: 0,
  openPanel: () => {},
  closePanel: () => {},
  setLayerVisible: () => {},
};

function resetOverlay(id: string, excludes: string[] = []): void {
  createOverlayStore({ overlayId: id, extra: {} });
  registerOverlayEntry({
    id,
    getState: () => getRegisteredOverlayStore(id)?.getState() ?? FALLBACK,
    useActive: () => false,
    excludes,
  });
}

beforeEach(() => {
  // A deep-linked overlay excluding another, so applying it exercises the
  // exclusion-peer capture runOverlayTransaction now routes through.
  resetOverlay("weather", ["air-quality"]);
  resetOverlay("air-quality", ["weather"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("DeepLinkManager overlay application", () => {
  it("opens a deep-linked overlay (user intent) and closes its exclusion peer through the transaction", () => {
    getRegisteredOverlayStore("air-quality")?.getState().openPanel();
    expect(isOverlayActive("air-quality")).toBe(true);

    window.history.replaceState(null, "", "/?ov=weather");
    render(<DeepLinkManager />);

    expect(isOverlayActive("weather")).toBe(true);
    expect(isOverlayActive("air-quality")).toBe(false);
  });

  it("closes an overlay no longer named by the link", () => {
    getRegisteredOverlayStore("weather")?.getState().openPanel();
    expect(isOverlayActive("weather")).toBe(true);

    window.history.replaceState(null, "", "/?ov=air-quality");
    render(<DeepLinkManager />);

    expect(isOverlayActive("air-quality")).toBe(true);
    expect(isOverlayActive("weather")).toBe(false);
  });
});
