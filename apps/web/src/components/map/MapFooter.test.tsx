// @vitest-environment jsdom

import { dataSourceToAttribution } from "@openmapx/integration-framework";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/lib/mapAttributionStore";
import { attributionToHtml } from "@/lib/useMapAttributions";
import { MapFooter } from "./MapFooter";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

beforeEach(() => {
  useMapAttributionStore.setState({ byLayer: {} });
});

describe("MapFooter", () => {
  it("renders the map credits inline instead of behind a collapsed toggle", () => {
    useMapAttributionStore.setState({
      byLayer: {
        base: ['© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'],
        route: ["© Valhalla"],
      },
    });
    render(<MapFooter />);
    const credits = screen.getByTestId("map-attributions");
    expect(credits.textContent).toContain("OpenStreetMap");
    expect(credits.textContent).toContain("Valhalla");
    // The publisher link stays clickable in the strip.
    expect(credits.querySelector("a")?.getAttribute("href")).toBe(
      "https://www.openstreetmap.org/copyright",
    );
  });

  it("states the license of a manifest data source, as the overlay legend does", () => {
    // CC-BY-style licenses require the license itself to be indicated, not just
    // the publisher. Before the strip rendered it, the overlay legend was the
    // only place it appeared.
    useMapAttributionStore.setState({
      byLayer: {
        "integration:overlay-air-quality": [
          attributionToHtml(
            dataSourceToAttribution({
              sourceId: "openaq",
              name: "OpenAQ",
              url: "https://api.openaq.org/",
              license: "CC BY 4.0",
              licenseUrl: "https://docs.openaq.org/resources/licenses",
              providerCountry: "US",
              providerPrivacyUrl: "https://openaq.org/privacy/",
            }),
          ),
        ],
      },
    });
    render(<MapFooter />);
    const credits = screen.getByTestId("map-attributions");
    expect(credits.textContent).toContain("OpenAQ");
    expect(credits.textContent).toContain("CC BY 4.0");
    expect(
      credits.querySelector('a[href="https://docs.openaq.org/resources/licenses"]'),
    ).not.toBeNull();
  });

  it("omits the credits bar entirely when nothing is registered", () => {
    render(<MapFooter />);
    expect(screen.queryByTestId("map-attributions")).toBeNull();
  });
});
