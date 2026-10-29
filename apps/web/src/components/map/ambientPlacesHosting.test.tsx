// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useWildfireStore } from "@integrations/overlay-wildfires/store";
import {
  getOverlayEntry,
  initOverlayRegistry,
  isOverlayActive,
  OVERLAY_REGISTRY,
  toggleOverlay,
} from "@openmapx/core";
import type { IntegrationMetadata } from "@openmapx/core/api-contracts";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: true }),
}));
// The renderer's own lifecycle is covered beside it; this file pins how the
// host decides to mount it from the real integration metadata.
vi.mock("@integrations/overlay-ambient-places/map-layer", async () => {
  const { createElement } = await import("react");
  const AmbientPlacesLayer = () => createElement("div", { "data-testid": "ambient-places-layer" });
  return { default: AmbientPlacesLayer, AmbientPlacesLayer };
});

import { DeepLinkManager } from "./DeepLinkManager";
import { MapLayerHost } from "./MapLayerHost";

function realIntegration(id: string, enabled = true): IntegrationMetadata {
  const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), "integrations", id, "manifest.json"), "utf8"),
  ) as IntegrationMetadata;
  return {
    id,
    name: id,
    enabled,
    isBuiltIn: true,
    domains: manifest.domains,
    frontend: manifest.frontend,
  };
}

function withRegistry(registry: IntegrationRegistry, children: ReactNode) {
  return (
    <IntegrationRegistryContext.Provider value={registry}>
      {children}
    </IntegrationRegistryContext.Provider>
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  useWildfireStore.getState().closePanel();
});

afterEach(() => {
  cleanup();
  initOverlayRegistry([]);
  window.history.replaceState(null, "", "/");
});

describe("published places as ordinary map content", () => {
  it("declares a map layer but no user-facing selector, legend or overlay", () => {
    const ambient = realIntegration("overlay-ambient-places");
    const registry = new IntegrationRegistry([ambient]);
    initOverlayRegistry([ambient]);

    expect(registry.getWithMapLayer().map((i) => i.id)).toEqual(["overlay-ambient-places"]);
    expect(registry.getWithLayerSelector()).toEqual([]);
    expect(registry.getWithLegend()).toEqual([]);
    expect(ambient.frontend?.overlay).toBeUndefined();
    expect(getOverlayEntry("ambient-places")).toBeUndefined();
    expect(OVERLAY_REGISTRY.map((entry) => entry.id)).not.toContain("ambient-places");
  });

  it("mounts the renderer only while the integration is enabled", async () => {
    const view = render(
      withRegistry(
        new IntegrationRegistry([realIntegration("overlay-ambient-places")]),
        <MapLayerHost />,
      ),
    );
    expect(await screen.findByTestId("ambient-places-layer")).toBeTruthy();

    view.rerender(
      withRegistry(
        new IntegrationRegistry([realIntegration("overlay-ambient-places", false)]),
        <MapLayerHost />,
      ),
    );
    expect(screen.queryByTestId("ambient-places-layer")).toBeNull();

    view.rerender(
      withRegistry(
        new IntegrationRegistry([realIntegration("overlay-ambient-places")]),
        <MapLayerHost />,
      ),
    );
    expect(await screen.findByTestId("ambient-places-layer")).toBeTruthy();
  });

  it("keeps a legacy ambient link usable beside a real overlay and stops serializing it", async () => {
    const ambient = realIntegration("overlay-ambient-places");
    // Overlay state knows both manifests; only the ambient renderer is hosted
    // because the wildfire renderer needs a real map.
    initOverlayRegistry([ambient, realIntegration("overlay-wildfires")]);
    window.history.replaceState(null, "", "/?ov=ambient-places,wildfires");

    render(
      withRegistry(
        new IntegrationRegistry([ambient]),
        <>
          <DeepLinkManager />
          <MapLayerHost />
        </>,
      ),
    );

    expect(await screen.findByTestId("ambient-places-layer")).toBeTruthy();
    expect(isOverlayActive("wildfires")).toBe(true);
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("ov")).toBe("wildfires"),
    );

    // Toggling an unrelated overlay never hides the automatic content.
    act(() => void toggleOverlay("wildfires", { kind: "user" }));
    expect(isOverlayActive("wildfires")).toBe(false);
    expect(screen.getByTestId("ambient-places-layer")).toBeTruthy();
    expect(window.location.search).not.toContain("ambient-places");
  });
});
