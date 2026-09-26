// @vitest-environment jsdom

import { dataSourceToAttribution } from "@openmapx/integration-framework";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { attributionToHtml } from "@/integration-api/overlay/useMapAttributions";
import { getMapObstructionInsets } from "@/lib/mapObstructions";
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

  it("publishes its measured bottom extent so map controls clear wrapped credits", () => {
    const rect = HTMLElement.prototype.getBoundingClientRect;
    let clearance = 72;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.tagName === "FOOTER"
        ? new DOMRect(0, window.innerHeight - clearance, 320, 72)
        : rect.call(this);
    });
    const { container, unmount } = render(<MapFooter />);
    expect(getMapObstructionInsets().bottom).toBe(72);
    clearance = 168;
    fireEvent.transitionEnd(container.querySelector("footer") as HTMLElement);
    expect(getMapObstructionInsets().bottom).toBe(168);
    unmount();
    expect(getMapObstructionInsets().bottom).toBe(0);
    vi.restoreAllMocks();
  });
});
