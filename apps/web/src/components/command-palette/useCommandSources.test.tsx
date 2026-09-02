// @vitest-environment jsdom

import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// Off-map by default (the overlay commands below don't need one); the map
// actions suite swaps a context in.
const mapCtx = vi.hoisted(() => ({ current: null as { resetBearing: () => void } | null }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMapOptional: () => mapCtx.current }));

const alignState = vi.hoisted(() => ({ available: true, align: vi.fn() }));
vi.mock("@/lib/useAlignToStreets", () => ({ useAlignToStreets: () => alignState }));

const toggleOverlayMock = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    toggleOverlay: (...args: [string, unknown]) => {
      toggleOverlayMock(...args);
      return (actual.toggleOverlay as (...a: [string, unknown]) => unknown)(...args);
    },
    useSession: () => ({ data: null }),
    // The Parking command is gated on a stored record; this suite covers the
    // overlay commands, so the garage stays empty.
    useParkedLocations: () => ({ data: [] }),
  };
});

import {
  createOverlayStore,
  getRegisteredOverlayStore,
  isOverlayActive,
  type OverlayStoreBase,
  registerOverlayEntry,
} from "@openmapx/core";
import { useCommandSources } from "./useCommandSources";

const FALLBACK: OverlayStoreBase = {
  panelOpen: false,
  layerVisible: false,
  userRevision: 0,
  openPanel: () => {},
  closePanel: () => {},
  setLayerVisible: () => {},
};

const TEST_INTEGRATION = {
  id: "overlay-traffic-flow",
  name: "Traffic flow",
  enabled: true,
  domains: ["map-overlay"],
  isBuiltIn: false,
  frontend: {
    overlay: { excludes: [] as string[], minZoom: 0 },
  },
};

function wrapper({ children }: { children: ReactNode }) {
  const registry = new IntegrationRegistry([TEST_INTEGRATION]);
  return (
    <IntegrationRegistryContext.Provider value={registry}>
      {children}
    </IntegrationRegistryContext.Provider>
  );
}

describe("useCommandSources overlay commands", () => {
  it("toggles an overlay command with an explicit 'user' origin", () => {
    createOverlayStore({ overlayId: "traffic-flow", extra: {} });
    registerOverlayEntry({
      id: "traffic-flow",
      getState: () => getRegisteredOverlayStore("traffic-flow")?.getState() ?? FALLBACK,
      useActive: () => false,
      excludes: [],
    });

    const { result } = renderHook(() => useCommandSources({ openShortcutsDialog: () => {} }), {
      wrapper,
    });

    const command = result.current.find((c) => c.id === "overlays.traffic-flow");
    expect(command).toBeDefined();

    expect(isOverlayActive("traffic-flow")).toBe(false);
    command?.run();

    expect(toggleOverlayMock).toHaveBeenCalledWith("traffic-flow", { kind: "user" });
    expect(isOverlayActive("traffic-flow")).toBe(true);
  });
});

describe("useCommandSources map orientation commands", () => {
  const resetBearing = vi.fn();

  afterEach(() => {
    mapCtx.current = null;
    alignState.available = true;
    alignState.align.mockClear();
    resetBearing.mockClear();
  });

  function commands() {
    return renderHook(() => useCommandSources({ openShortcutsDialog: () => {} }), { wrapper })
      .result.current;
  }

  it("runs align and north-up on a map route", () => {
    mapCtx.current = { resetBearing };
    const out = commands();

    const alignCommand = out.find((c) => c.id === "actions.alignToStreets");
    expect(alignCommand?.iconKey).toBe("align-streets");
    alignCommand?.run();
    expect(alignState.align).toHaveBeenCalledTimes(1);

    const northCommand = out.find((c) => c.id === "actions.northUp");
    expect(northCommand?.iconKey).toBe("north-up");
    northCommand?.run();
    expect(resetBearing).toHaveBeenCalledTimes(1);
  });

  it("drops align while the map cannot be aligned but keeps north-up", () => {
    mapCtx.current = { resetBearing };
    alignState.available = false;
    const out = commands();

    expect(out.find((c) => c.id === "actions.alignToStreets")).toBeUndefined();
    expect(out.find((c) => c.id === "actions.northUp")).toBeDefined();
  });

  it("offers neither off the map", () => {
    const out = commands();

    expect(out.find((c) => c.id === "actions.alignToStreets")).toBeUndefined();
    expect(out.find((c) => c.id === "actions.northUp")).toBeUndefined();
  });
});
