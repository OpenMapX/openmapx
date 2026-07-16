// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { EnvProvider } from "@/lib/EnvProvider";
import type { ClientEnv } from "@/lib/env";
import { IntegrationLayerPreview } from "./IntegrationLayerPreview";

function withEnv(children: ReactNode, apiUrl = "") {
  const env: ClientEnv = {
    apiUrl,
    mapillaryToken: "",
    mapStyleUrl: "",
    tilesUrl: "",
    styleProvider: "openmapx",
    trafficMinZoom: 10,
    trafficTileUrlTemplate: "",
    cyclOsmTileUrlTemplate: "",
    terrainTileUrlTemplate: "",
    martinBaseUrl: "",
  };
  return <EnvProvider config={env}>{children}</EnvProvider>;
}

describe("IntegrationLayerPreview", () => {
  it("uses the same-origin endpoint and decorative lazy image attributes", () => {
    const { container } = render(
      withEnv(<IntegrationLayerPreview integrationId="overlay-weather" />),
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/api/integrations/overlay-weather/preview");
    expect(image?.getAttribute("alt")).toBe("");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(image?.getAttribute("decoding")).toBe("async");
  });

  it("trims one trailing slash and encodes the integration ID", () => {
    const { container } = render(
      withEnv(
        <IntegrationLayerPreview integrationId="community/example" />,
        "http://localhost:3001/",
      ),
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "http://localhost:3001/api/integrations/community%2Fexample/preview",
    );
  });

  it("falls back to the generic preview when the image fails", () => {
    const { container } = render(withEnv(<IntegrationLayerPreview integrationId="missing" />));
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("resets the failure state when the endpoint changes", () => {
    const { container, rerender } = render(
      withEnv(<IntegrationLayerPreview integrationId="missing" />),
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    rerender(withEnv(<IntegrationLayerPreview integrationId="available" />));
    expect(container.querySelector("img")?.getAttribute("src")).toContain("available/preview");
  });
});
