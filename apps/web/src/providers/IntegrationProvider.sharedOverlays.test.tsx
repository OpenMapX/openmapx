import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  initOverlayRegistry,
  OVERLAY_REGISTRY,
  toggleOverlay,
  useStreetLevelStore,
} from "@openmapx/core";
import type { IntegrationMetadata } from "@openmapx/core/api-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLayerSelectorConfig } from "@/components/map/layer-selector/useLayerSelectorConfig";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { invalidateIntegrationRuntime } from "@/lib/integrationRuntimeQuery";
import { IntegrationProvider } from "./IntegrationProvider";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.example.test" }),
}));

const integrations = ["mapillary", "panoramax"].map((provider) => {
  const id = `street-level-imagery-${provider}`;
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "integrations", id, "manifest.json"), "utf8"),
  ) as IntegrationMetadata;
  return {
    id,
    name: id,
    enabled: true,
    isBuiltIn: true,
    domains: manifest.domains,
    frontend: manifest.frontend,
  };
});

function SharedOverlayControls() {
  const { mapDetails } = useLayerSelectorConfig();
  return mapDetails.map((entry) => (
    <button
      key={entry.id}
      type="button"
      onClick={() => toggleOverlay(entry.overlayId, { kind: "user" })}
    >
      Street-level imagery
    </button>
  ));
}

let metadata: IntegrationMetadata[];
let client: QueryClient;

beforeEach(() => {
  metadata = integrations;
  initOverlayRegistry([]);
  useStreetLevelStore.getState().closePanel();
  useMapAttributionStore.setState({ byLayer: {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", async () =>
    Response.json({
      revision: "a".repeat(64),
      integrations: metadata,
      frameworkStrings: {},
      disclosures: [],
    }),
  );
});

afterEach(() => {
  cleanup();
  client.clear();
  initOverlayRegistry([]);
  useStreetLevelStore.getState().closePanel();
  vi.unstubAllGlobals();
});

it("initializes both imagery providers with one toggle, retaining it through refresh without claiming configured sources", async () => {
  render(
    <QueryClientProvider client={client}>
      <IntegrationProvider>
        <SharedOverlayControls />
      </IntegrationProvider>
    </QueryClientProvider>,
  );

  const toggle = await screen.findByRole("button", { name: "Street-level imagery" });
  expect(screen.getAllByRole("button", { name: "Street-level imagery" })).toHaveLength(1);
  expect(OVERLAY_REGISTRY.map((entry) => entry.id)).toEqual(["street-level-imagery"]);

  fireEvent.click(toggle);
  expect(useStreetLevelStore.getState().panelOpen).toBe(true);
  const credits = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml);
  await waitFor(() => {
    expect(credits()).toHaveLength(0);
  });

  metadata = integrations.filter(
    (integration) => integration.id === "street-level-imagery-panoramax",
  );
  await act(() => invalidateIntegrationRuntime(client, "https://api.example.test"));
  await waitFor(() => {
    expect(OVERLAY_REGISTRY.map((entry) => entry.serviceId)).toEqual([
      "street-level-imagery-panoramax",
    ]);
    expect(useStreetLevelStore.getState().layerVisible).toBe(true);
    expect(credits()).toHaveLength(0);
  });

  metadata = [];
  await act(() => invalidateIntegrationRuntime(client, "https://api.example.test"));
  await waitFor(() => {
    expect(screen.queryByRole("button", { name: "Street-level imagery" })).toBeNull();
    expect(OVERLAY_REGISTRY).toHaveLength(0);
    expect(credits()).toHaveLength(0);
  });
});
