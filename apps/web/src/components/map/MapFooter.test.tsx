import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";

// @vitest-environment jsdom

import { buildAttributionPresentation } from "@openmapx/core/attribution";
import { dataSourceToAttribution } from "@openmapx/integration-framework";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
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
        base: [
          buildAttributionPresentation(
            {
              sourceId: "openstreetmap",
              name: "OpenStreetMap",
              url: "https://www.openstreetmap.org/copyright",
            },
            "map",
          ),
        ],
        route: [buildAttributionPresentation({ sourceId: "valhalla", name: "© Valhalla" }, "map")],
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
          buildAttributionPresentation(
            dataSourceToAttribution({
              sourceId: "openaq",
              name: "OpenAQ",
              url: "https://api.openaq.org/",
              licensing: licensingFromDeclaration(
                "CC BY 4.0",
                "https://docs.openaq.org/resources/licenses",
                "OpenAQ",
              ),
              providerCountry: "US",
              providerPrivacyUrl: "https://openaq.org/privacy/",
            }),
            "map",
          ),
        ],
      },
    });
    render(<MapFooter />);
    fireEvent.click(screen.getByRole("button", { name: "credits" }));
    const credits = screen.getByRole("dialog");
    expect(credits.textContent).toContain("OpenAQ");
    expect(credits.textContent).toContain("CC-BY-4.0");
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

it("keeps one hundred eligible sources out of the permanent strip and exposes every notice in one action", () => {
  useMapAttributionStore.setState({
    byLayer: {
      overlay: Array.from({ length: 100 }, (_, index) =>
        buildAttributionPresentation(
          {
            sourceId: `agency-${index}`,
            name: `Agency ${index}`,
            attributionText: `Required notice ${index}`,
            licensing: licensingFromDeclaration("CC-BY-4.0"),
          },
          "map",
        ),
      ),
    },
  });
  render(<MapFooter />);
  expect(screen.getByTestId("map-attributions").textContent).not.toContain("Required notice 99");
  fireEvent.click(screen.getByRole("button", { name: "credits" }));
  expect(screen.getByRole("dialog").querySelectorAll("li")).toHaveLength(100);
  expect(screen.getByRole("dialog").textContent).toContain("Required notice 99");
});

it("offers layer management for unusually tall required credits without clipping them", () => {
  const actual = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === "mandatory-map-attributions"
      ? new DOMRect(0, 0, 320, window.innerHeight / 2)
      : actual.call(this);
  });
  useMapAttributionStore.setState({
    byLayer: {
      required: [
        buildAttributionPresentation(
          {
            sourceId: "required",
            name: "Required publisher",
            attributionText: "Full compulsory source wording",
          },
          "map",
        ),
      ],
    },
  });
  const opened = vi.fn();
  window.addEventListener("openmapx:open-layer-selector", opened);
  render(<MapFooter />);
  expect(screen.getByTestId("mandatory-map-attributions").textContent).toContain(
    "Full compulsory source wording",
  );
  fireEvent.click(screen.getByRole("button", { name: "manageOverlays" }));
  expect(opened).toHaveBeenCalledTimes(1);
  window.removeEventListener("openmapx:open-layer-selector", opened);
  vi.restoreAllMocks();
});

describe("footer background joining", () => {
  it.each([
    {
      name: "different-height bars on a roomy desktop row",
      legal: [0, 783, 192, 17],
      credits: [791, 772, 489, 28],
      joined: false,
    },
    {
      name: "a legal bar taller than the credits on the same row",
      legal: [0, 766, 192, 34],
      credits: [791, 772, 489, 28],
      joined: false,
    },
    {
      name: "a fractional-pixel bottom alignment on the same row",
      legal: [0, 783.5, 192, 17],
      credits: [791, 772, 489, 28],
      joined: false,
    },
    {
      name: "bars with just enough space between them",
      legal: [0, 783, 192, 17],
      credits: [208, 772, 489, 28],
      joined: false,
    },
    {
      name: "bars that are close together",
      legal: [0, 783, 192, 17],
      credits: [207, 772, 489, 28],
      joined: true,
    },
    {
      name: "credits wrapped below the legal links",
      legal: [0, 755, 192, 17],
      credits: [0, 772, 390, 28],
      joined: true,
    },
  ])("paints the expected background for $name", ({ legal, credits, joined }) => {
    // jsdom has no layout. These rectangles reproduce actual bottom-aligned
    // flex rows, including the taller Map credits button measured in a browser.
    const actual = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === "map-attributions")
        return new DOMRect(credits[0], credits[1], credits[2], credits[3]);
      if (this.parentElement?.tagName === "FOOTER")
        return new DOMRect(legal[0], legal[1], legal[2], legal[3]);
      return actual.call(this);
    });
    try {
      useMapAttributionStore.setState({
        byLayer: {
          base: [buildAttributionPresentation({ sourceId: "osm", name: "OpenStreetMap" }, "map")],
        },
      });
      const { container } = render(<MapFooter />);
      const footer = container.querySelector("footer") as HTMLElement;
      const transparent = "rgba(0, 0, 0, 0)";
      expect(getComputedStyle(footer).backgroundColor === transparent).toBe(!joined);
      expect(
        getComputedStyle(footer.firstElementChild as HTMLElement).backgroundColor === transparent,
      ).toBe(joined);
      expect(
        getComputedStyle(screen.getByTestId("map-attributions")).backgroundColor === transparent,
      ).toBe(joined);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("joins and separates the bars again as available space changes", () => {
    let creditsLeft = 791;
    const actual = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === "map-attributions") return new DOMRect(creditsLeft, 772, 489, 28);
      if (this.parentElement?.tagName === "FOOTER") return new DOMRect(0, 783, 192, 17);
      return actual.call(this);
    });
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      useMapAttributionStore.setState({
        byLayer: {
          base: [buildAttributionPresentation({ sourceId: "osm", name: "OpenStreetMap" }, "map")],
        },
      });
      const { container } = render(<MapFooter />);
      const footer = container.querySelector("footer") as HTMLElement;
      expect(getComputedStyle(footer).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      act(() => {
        creditsLeft = 207;
        for (const callback of callbacks) callback([], {} as ResizeObserver);
      });
      expect(getComputedStyle(footer).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      act(() => {
        creditsLeft = 791;
        for (const callback of callbacks) callback([], {} as ResizeObserver);
      });
      expect(getComputedStyle(footer).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
