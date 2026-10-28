import maptilerManifest from "@integrations/geocoding-maptiler/manifest.json";
import { licensingFromDeclaration, parseLicensing } from "@openmapx/mobility-core/licensing";

// @vitest-environment jsdom

import { buildAttributionPresentation } from "@openmapx/core/attribution";
import { dataSourceToAttribution } from "@openmapx/integration-framework";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { getMapObstructionInsets } from "@/lib/mapObstructions";
import { MapFooter } from "./MapFooter";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const follow = vi.hoisted(() => ({
  track: null as import("@/lib/sheetFollow").SheetFollowTrack | null,
}));
vi.mock("@/lib/sheetFollow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sheetFollow")>()),
  useSheetFollowTrack: () => follow.track,
}));

beforeEach(() => {
  useMapAttributionStore.setState({ byLayer: {} });
});

it("shows one captured MapTiler credit across owners while earlier basemap credits change", () => {
  const source = maptilerManifest.dataSources[0];
  const maptiler = buildAttributionPresentation(
    {
      sourceId: source.sourceId,
      name: source.name,
      url: source.url,
      attributionText: source.attribution,
      licensing: parseLicensing(source.licensing),
    },
    "map",
  );
  const osm = buildAttributionPresentation({ sourceId: "osm", name: "© OSM" }, "map");
  const terrain = buildAttributionPresentation({ sourceId: "terrain", name: "© Terrain" }, "map");
  const show = (terrainVisible: boolean) =>
    useMapAttributionStore.setState({
      byLayer: {
        base: terrainVisible ? [osm, terrain] : [osm],
        "rendered:pin-marker::one": [maptiler],
        "rendered:pin-label::two": [maptiler],
      },
    });
  show(false);
  render(<MapFooter />);
  const notices = within(screen.getByTestId("mandatory-map-attributions"));
  expect(notices.getAllByRole("link", { name: "MapTiler" })).toHaveLength(1);
  for (let i = 0; i < 4; i++) {
    act(() => show(true));
    expect(notices.getAllByRole("link", { name: "MapTiler" })).toHaveLength(1);
    act(() => show(false));
    expect(notices.getAllByRole("link", { name: "MapTiler" })).toHaveLength(1);
  }
  expect(
    notices.getByRole("link", { name: "OpenStreetMap contributors" }).getAttribute("href"),
  ).toBe("https://www.openstreetmap.org/copyright");
  expect(notices.getByRole("link", { name: "Licence not specified" }).getAttribute("href")).toBe(
    "https://www.maptiler.com/terms/cloud/",
  );
  act(() => useMapAttributionStore.setState({ byLayer: { base: [osm] } }));
  expect(notices.queryByRole("link", { name: "MapTiler" })).toBeNull();
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

it("rides a driving sheet on the compositor from its zero-height edge, and stops once docked", () => {
  follow.track = { scrollStart: 4, cap: 440, lift: 20, floor: 30 };
  try {
    const { container } = render(<MapFooter />);
    const footer = container.querySelector("footer") as HTMLElement;
    const className = [...footer.classList].find((name) => name.startsWith("css-"));
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("");
    const rules = css.split("}").filter((rule) => rule.includes(`.${className}`));
    // clamp(floor 30, lift 20 + f): flat until f = 10, then 1px per sheet pixel to the cap.
    expect(rules.some((rule) => /min-width:0px\)\{[^{]*\{bottom:30px/.test(rule))).toBe(true);
    expect(css).toContain("animation-range:14px 444px;");
    expect(css).toContain("--omx-sheet-follow-travel:430px;");
    const docked = rules.find((rule) => rule.includes('[data-map-footer-surface="sheet"]>'));
    expect(docked).toContain("animation:none");
  } finally {
    follow.track = null;
  }
});
