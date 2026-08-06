// @vitest-environment jsdom

import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const toggleOverlayMock = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    // Spies on the call args while still exercising the real transaction, so
    // this test both proves the origin passed AND that the overlay actually
    // toggles.
    toggleOverlay: (...args: [string, unknown]) => {
      toggleOverlayMock(...args);
      return (actual.toggleOverlay as (...a: [string, unknown]) => unknown)(...args);
    },
    useCapabilities: () => ({
      isAvailable: () => true,
      services: {},
      getCapability: () => undefined,
    }),
  };
});

import {
  createOverlayStore,
  getRegisteredOverlayStore,
  isOverlayActive,
  type OverlayStoreBase,
  registerOverlayEntry,
} from "@openmapx/core";
import { DesktopQuickSelector } from "./DesktopQuickSelector";

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
    layerSelector: {
      group: "map-details" as const,
      labelKey: "trafficFlow",
      quickSelector: true,
    },
    overlay: { excludes: [] as string[], minZoom: 0 },
  },
};

beforeEach(() => {
  toggleOverlayMock.mockClear();
  createOverlayStore({ overlayId: "traffic-flow", extra: {} });
  registerOverlayEntry({
    id: "traffic-flow",
    getState: () => getRegisteredOverlayStore("traffic-flow")?.getState() ?? FALLBACK,
    useActive: () => false,
    excludes: [],
  });
});

function renderSelector() {
  const registry = new IntegrationRegistry([TEST_INTEGRATION]);
  return render(
    <IntegrationRegistryContext.Provider value={registry}>
      <DesktopQuickSelector onMoreClick={() => {}} />
    </IntegrationRegistryContext.Provider>,
  );
}

describe("DesktopQuickSelector", () => {
  it("toggles an overlay tile with an explicit 'user' origin", () => {
    renderSelector();
    expect(isOverlayActive("traffic-flow")).toBe(false);

    // mockNextIntl's t(key) returns "<namespace>.<key>"; DesktopQuickSelector
    // calls useTranslations("layers").
    fireEvent.click(screen.getByText("layers.trafficFlow"));

    expect(toggleOverlayMock).toHaveBeenCalledWith("traffic-flow", { kind: "user" });
    expect(isOverlayActive("traffic-flow")).toBe(true);
  });
});
