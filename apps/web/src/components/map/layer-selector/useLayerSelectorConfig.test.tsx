// @vitest-environment jsdom

import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { EnvProvider } from "@/lib/EnvProvider";
import type { ClientEnv } from "@/lib/env";
import { IntegrationLayerPreview } from "./IntegrationLayerPreview";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

const env: ClientEnv = {
  apiUrl: "",
  mapStyleUrl: "",
  tilesUrl: "",
  styleProvider: "openmapx",
  trafficTileUrlTemplate: "",
  cyclOsmTileUrlTemplate: "",
  terrainTileUrlTemplate: "",
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
