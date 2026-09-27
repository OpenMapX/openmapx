// @vitest-environment jsdom

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { EnvProvider } from "@/integration-api/runtime/EnvProvider";
import type { ClientEnv } from "@/integration-api/runtime/env";
import { IntegrationLayerPreview } from "./IntegrationLayerPreview";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

const env: ClientEnv = {
  apiUrl: "",
  mapStyleUrl: "",
  tilesUrl: "",
  styleProvider: "openmapx",
  trafficTileUrlTemplate: "",
  cyclOsmTileUrlTemplate: "",
  terrainDemTilejsonUrl: "",
  terrainContourTilejsonUrl: "",
  terrainAttributionName: "© MapTiler",
  terrainAttributionUrl: "https://www.maptiler.com/copyright/",
  martinBaseUrl: "",
};

function getPreview(preview: string | null | undefined): ReactNode {
  const integration = {
    id: "street-level-imagery-mapillary",
    name: "Community preview",
    enabled: true,
    domains: ["map-overlay"],
    isBuiltIn: false,
    frontend: {
      layerSelector: {
        group: "map-details" as const,
        labelKey: "streetLevel",
        ...(preview === undefined ? {} : { preview }),
      },
    },
  };
  const registry = new IntegrationRegistry([integration]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <IntegrationRegistryContext.Provider value={registry}>
      {children}
    </IntegrationRegistryContext.Provider>
  );
  return renderHook(() => useLayerSelectorConfig(), { wrapper }).result.current.mapDetails[0]
    ?.preview;
}

describe("useLayerSelectorConfig previews", () => {
  it("uses a declared preview with the original integration ID, not its overlay alias", () => {
    const preview = getPreview("preview.svg");
    expect(isValidElement(preview)).toBe(true);
    if (!isValidElement<{ integrationId: string }>(preview)) return;
    expect(preview.type).toBe(IntegrationLayerPreview);
    expect(preview.props.integrationId).toBe("street-level-imagery-mapillary");

    const { container } = render(<EnvProvider config={env}>{preview}</EnvProvider>);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/integrations/street-level-imagery-mapillary/preview",
    );
  });

  it("uses the generic placeholder when preview is omitted", () => {
    const preview = getPreview(undefined);
    const { container } = render(<EnvProvider config={env}>{preview}</EnvProvider>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("uses the generic placeholder when preview is null", () => {
    const preview = getPreview(null);
    const { container } = render(<EnvProvider config={env}>{preview}</EnvProvider>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

describe("purpose-based layer groups", () => {
  it("assigns every current catalog detail to one purpose group", () => {
    const catalogDir = join(process.cwd(), "integrations");
    const integrations = readdirSync(catalogDir)
      .map((name) => join(catalogDir, name, "manifest.json"))
      .filter(existsSync)
      .map(
        (path) =>
          JSON.parse(readFileSync(path, "utf8")) as {
            id: string;
            domains: string[];
            frontend?: {
              layerSelector?: {
                group: "map-details" | "map-tools" | "map-types";
                labelKey: string;
              };
            };
          },
      )
      .flatMap((manifest) => {
        const layerSelector = manifest.frontend?.layerSelector;
        if (layerSelector?.group !== "map-details") return [];
        return [
          {
            id: manifest.id,
            name: manifest.id,
            enabled: true,
            domains: manifest.domains,
            isBuiltIn: false,
            frontend: { layerSelector },
          },
        ];
      });
    const registry = new IntegrationRegistry(integrations);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <IntegrationRegistryContext.Provider value={registry}>
        {children}
      </IntegrationRegistryContext.Provider>
    );

    const { result } = renderHook(() => useLayerSelectorConfig(), { wrapper });
    expect(
      Object.fromEntries(
        result.current.detailGroups.map(({ id, entries }) => [
          id,
          entries.map((entry) => entry.overlayId).sort(),
        ]),
      ),
    ).toEqual({
      transport: [
        "cycling",
        "live-transit",
        "nautical",
        "ourairports",
        "road-conditions",
        "schematic-transit",
        "traffic",
        "traffic-flow",
        "transit",
      ],
      outdoors: ["3d-buildings", "hiking", "satellite", "street-level-imagery", "winter-sports"],
      weatherEnvironment: [
        "air-quality",
        "earthquakes",
        "environment",
        "natural-events",
        "sun-time",
        "weather",
        "weather-alerts",
        "wildfires",
      ],
    });
    expect(result.current.mapDetails).toHaveLength(22);
  });

  it("keeps each selectable detail once and exposes unknown integrations", () => {
    const ids = [
      "overlay-traffic-flow",
      "overlay-hiking",
      "overlay-weather",
      "street-level-imagery-mapillary",
      "street-level-imagery-panoramax",
      "overlay-new-detail",
    ];
    const registry = new IntegrationRegistry(
      ids.map((id) => ({
        id,
        name: id,
        enabled: true,
        domains: ["map-overlay"],
        isBuiltIn: false,
        frontend: { layerSelector: { group: "map-details" as const, labelKey: id } },
      })),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <IntegrationRegistryContext.Provider value={registry}>
        {children}
      </IntegrationRegistryContext.Provider>
    );

    const { result } = renderHook(() => useLayerSelectorConfig(), { wrapper });
    expect(
      result.current.detailGroups.map(({ id, entries }) => [
        id,
        entries.map((entry) => entry.overlayId),
      ]),
    ).toEqual([
      ["transport", ["traffic-flow"]],
      ["outdoors", ["hiking", "street-level-imagery"]],
      ["weatherEnvironment", ["weather"]],
      ["otherDetails", ["new-detail"]],
    ]);
    expect(result.current.mapDetails.map((entry) => entry.overlayId)).toEqual([
      "traffic-flow",
      "hiking",
      "weather",
      "street-level-imagery",
      "new-detail",
    ]);
  });
});
