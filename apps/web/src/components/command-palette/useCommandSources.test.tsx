// @vitest-environment jsdom

import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/MapContext", () => ({ useMapOptional: () => null }));

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
