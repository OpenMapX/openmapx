// @vitest-environment jsdom

import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, fireEvent, render, screen, userEvent, waitFor, within } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/MapContext", () => {
  const mapContext = {
    mapRef: { current: null as unknown },
    mapReady: true,
    styleVersion: 0,
  };
  return { __test: mapContext, useMap: () => mapContext };
});
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  const state = {
    reverseData: null as { address: string; city: string } | null,
    requiredLocale: null as string | null,
  };
  return {
    ...actual,
    __test: state,
    useReverseGeocoding: (_coordinates: [number, number] | null, locale?: string) => ({
      data: !state.requiredLocale || locale === state.requiredLocale ? state.reverseData : null,
      isLoading: false,
    }),
  };
});
vi.mock("@/lib/deepLink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/deepLink")>();
  const shareUrl = vi.fn();
  return { ...actual, __test: shareUrl, shareUrl };
});

import * as coreModule from "@openmapx/core";
import {
  createPlace,
  PANEL,
  useDirectionsStore,
  useMapClickStore,
  useNavigationStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import * as deepLinkModule from "@/lib/deepLink";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import * as mapContextModule from "@/lib/MapContext";
import { MapContextMenu } from "./MapContextMenu";

const coreTest = (
  coreModule as unknown as {
    __test: {
      reverseData: { address: string; city: string } | null;
      requiredLocale: string | null;
    };
  }
).__test;
const mapContextTest = (
  mapContextModule as unknown as {
    __test: { mapRef: { current: unknown }; mapReady: boolean; styleVersion: number };
  }
).__test;
const shareUrlMock = (deepLinkModule as unknown as { __test: ReturnType<typeof vi.fn> }).__test;

let fake: ReturnType<typeof createFakeMap>;
let domContextCoordinates: [number, number];

function poiFeature(name = "Smithsonian Institution Building"): MapGeoJSONFeature {
  return {
    type: "Feature",
    id: 42,
    geometry: { type: "Point", coordinates: [-77.026, 38.889] },
    properties: { name, class: "culture", subclass: "museum" },
    layer: { id: "poi-label", type: "symbol" },
    source: "openmaptiles",
    sourceLayer: "poi",
    state: {},
  } as unknown as MapGeoJSONFeature;
}

function openAtMapPoint(
  overrides: {
    coordinates?: [number, number];
    pointerType?: string;
    sourceCapabilities?: { firesTouchEvents?: boolean };
  } = {},
) {
  const preventDefault = vi.fn();
  const [lng, lat] = overrides.coordinates ?? [-77.02573, 38.88859];
  act(() => {
    fake.emit("contextmenu", {
      point: { x: 40, y: 50 },
      lngLat: { lng, lat },
      originalEvent: {
        clientX: 120,
        clientY: 140,
        pointerType: overrides.pointerType ?? "mouse",
        sourceCapabilities: overrides.sourceCapabilities,
        preventDefault,
      },
    });
  });
  return preventDefault;
}

function dispatchDomMapContextMenu(coordinates: [number, number]) {
  domContextCoordinates = coordinates;
  const modalRoot = document.querySelector<HTMLElement>(".MuiPopover-root");
  const blockingLayer =
    modalRoot && getComputedStyle(modalRoot).pointerEvents !== "none"
      ? (modalRoot.querySelector<HTMLElement>(".MuiBackdrop-root") ?? modalRoot)
      : fake.state.canvas;
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 240,
    clientY: 260,
  });
  fireEvent(blockingLayer, event);
  return { blockingLayer, event };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function focusVisibleStyle(element: HTMLElement): CSSStyleDeclaration | undefined {
  const generatedClass = [...element.classList].find((className) => className.startsWith("css-"));
  if (!generatedClass) return undefined;
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText === `.${generatedClass}.Mui-focusVisible`
      ) {
        return rule.style;
      }
    }
  }
  return undefined;
}

beforeEach(() => {
  fake = createFakeMap({
    baseLayers: [{ id: "poi-label", type: "symbol", "source-layer": "poi" } as never],
  });
  domContextCoordinates = [-77.02573, 38.88859];
  fake.state.canvas.addEventListener("contextmenu", (event) => {
    const [lng, lat] = domContextCoordinates;
    fake.emit("contextmenu", {
      point: { x: event.clientX, y: event.clientY },
      lngLat: { lng, lat },
      originalEvent: event,
    });
  });
  document.body.appendChild(fake.state.canvas);
  mapContextTest.mapRef.current = fake.map;
  mapContextTest.mapReady = true;
  mapContextTest.styleVersion = 0;
  coreTest.reverseData = null;
  coreTest.requiredLocale = null;
  shareUrlMock.mockReset();
  shareUrlMock.mockResolvedValue("shared");
  useDirectionsStore.getState().close();
  useNavigationStore.setState({ status: "idle" });
  useMapClickStore.setState({ clickedLngLat: null });
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

afterEach(() => {
  fake.state.canvas.remove();
  mapContextTest.mapRef.current = null;
  useDirectionsStore.getState().close();
  useNavigationStore.setState({ status: "idle" });
  useMapClickStore.setState({ clickedLngLat: null });
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
});

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

async function openCopySubmenu() {
  await userEvent.click(screen.getByRole("menuitem", { name: "mapContextMenu.copyLocation" }));
  return screen.getByRole("menu");
}

describe("MapContextMenu opening", () => {
  it("suppresses the native menu and opens a coordinate target with initial focus", () => {
    render(<MapContextMenu />);

    const preventDefault = openAtMapPoint();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu", { name: "mapContextMenu.ariaLabel" })).toBeDefined();
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "mapContextMenu.fromHere" }),
    );
    expect(screen.getByText("38.888590, -77.025730")).toBeDefined();
  });

  it("uses a named POI as the immutable target identity", () => {
    fake.setRenderedFeatures("poi-label", [poiFeature()]);
    render(<MapContextMenu />);

    openAtMapPoint();

    expect(screen.getByText("Smithsonian Institution Building")).toBeDefined();
  });

  it("falls back to the clicked coordinate when an app overlay obscures a basemap POI", () => {
    fake.map.addLayer({ id: "category-results-layer", type: "circle", source: "results" } as never);
    fake.setRenderedFeatures("poi-label", [poiFeature()]);
    fake.setRenderedFeatures("category-results-layer", [poiFeature("Overlay result")]);
    expect(INTERACTIVE_LAYER_IDS.has("category-results-layer")).toBe(true);
    render(<MapContextMenu />);

    openAtMapPoint();

    expect(screen.queryByText("Smithsonian Institution Building")).toBeNull();
    expect(screen.getByText("38.888590, -77.025730")).toBeDefined();
  });

  it("uses reverse-geocoded city and address for an unnamed point", () => {
    coreTest.reverseData = { city: "Washington", address: "1000 Jefferson Drive" };
    render(<MapContextMenu />);

    openAtMapPoint();

    expect(screen.getByText("Washington")).toBeDefined();
    expect(screen.getByText("1000 Jefferson Drive")).toBeDefined();
  });

  it("clamps long identity title and address to at most two lines", () => {
    coreTest.reverseData = {
      city: "A deliberately long reverse-geocoded city identity",
      address: "A deliberately long reverse-geocoded street address",
    };
    render(<MapContextMenu />);

    openAtMapPoint();

    for (const text of [coreTest.reverseData.city, coreTest.reverseData.address]) {
      const style = getComputedStyle(screen.getByText(text));
      expect(style.display).toBe("-webkit-box");
      expect(style.webkitLineClamp).toBe("2");
      expect(style.overflow).toBe("hidden");
    }
  });

  it("clears only the plain-map click target when opening", () => {
    useMapClickStore.setState({ clickedLngLat: [1, 2] });
    const selectedPlace = createPlace({
      primaryScheme: "test",
      ids: { test: "kept" },
      name: "Kept place",
      address: "Kept address",
      coordinates: [3, 4],
    });
    usePlaceStore.setState({ selectedPlace });
    useSidebarStore.setState({ activeSidebarId: PANEL.CATEGORY });
    const directionsBefore = useDirectionsStore.getState().waypoints;
    render(<MapContextMenu />);

    openAtMapPoint();

    expect(useMapClickStore.getState().clickedLngLat).toBeNull();
    expect(usePlaceStore.getState().selectedPlace).toBe(selectedPlace);
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    expect(useDirectionsStore.getState().waypoints).toBe(directionsBefore);
  });

  it("replaces the first target on a second invocation", () => {
    render(<MapContextMenu />);
    openAtMapPoint();

    openAtMapPoint({ coordinates: [13.405, 52.52] });

    expect(screen.getByText("52.520000, 13.405000")).toBeDefined();
    expect(screen.queryByText("38.888590, -77.025730")).toBeNull();
  });

  for (const overrides of [
    { pointerType: "touch" },
    { sourceCapabilities: { firesTouchEvents: true } },
  ]) {
    it("rejects a touch-originated context event", () => {
      render(<MapContextMenu />);

      const preventDefault = openAtMapPoint(overrides);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(screen.queryByRole("menu")).toBeNull();
    });
  }

  for (const status of ["navigating", "rerouting"] as const) {
    it(`suppresses the native menu without opening or mutating state while ${status}`, () => {
      useNavigationStore.setState({ status });
      useMapClickStore.setState({ clickedLngLat: [1, 2] });
      render(<MapContextMenu />);

      const preventDefault = openAtMapPoint();

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(useMapClickStore.getState().clickedLngLat).toEqual([1, 2]);
    });
  }

  it("permits opening after arrival", () => {
    useNavigationStore.setState({ status: "arrived" });
    render(<MapContextMenu />);

    openAtMapPoint();

    expect(screen.getByRole("menu")).toBeDefined();
  });
});

describe("MapContextMenu route and place actions", () => {
  it("replaces only the destination of a three-waypoint draft", async () => {
    const directions = useDirectionsStore.getState();
    directions.close();
    directions.addWaypoint(0);
    directions.setWaypoint(0, [6.1, 50.1], "Origin");
    directions.setWaypoint(1, [6.2, 50.2], "Via");
    directions.setWaypoint(2, [6.3, 50.3], "Old destination");
    render(<MapContextMenu />);
    openAtMapPoint();

    await userEvent.click(screen.getByRole("menuitem", { name: "mapContextMenu.toHere" }));

    expect(useDirectionsStore.getState().waypoints.map((waypoint) => waypoint.coords)).toEqual([
      [6.1, 50.1],
      [6.2, 50.2],
      [-77.02573, 38.88859],
    ]);
    expect(useDirectionsStore.getState().isOpen).toBe(true);
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.DIRECTIONS);
  });

  it("replaces only the origin of a three-waypoint draft", async () => {
    const directions = useDirectionsStore.getState();
    directions.addWaypoint(0);
    directions.setWaypoint(0, [6.1, 50.1], "Old origin");
    directions.setWaypoint(1, [6.2, 50.2], "Via");
    directions.setWaypoint(2, [6.3, 50.3], "Destination");
    render(<MapContextMenu />);
    openAtMapPoint();

    await userEvent.click(screen.getByRole("menuitem", { name: "mapContextMenu.fromHere" }));

    expect(useDirectionsStore.getState().waypoints.map((waypoint) => waypoint.coords)).toEqual([
      [-77.02573, 38.88859],
      [6.2, 50.2],
      [6.3, 50.3],
    ]);
  });

  it("opens a style POI in the full place sidebar with its canonical identity", async () => {
    fake.setRenderedFeatures("poi-label", [poiFeature()]);
    useSidebarStore.setState({ activeDetailId: PANEL.PLACE_CARD });
    render(<MapContextMenu />);
    openAtMapPoint();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "mapContextMenu.openPlaceDetails" }),
    );

    expect(usePlaceStore.getState().selectedPlace).toMatchObject({
      id: "stylePoi:42",
      name: "Smithsonian Institution Building",
      address: "Smithsonian Institution Building",
      coordinates: [-77.026, 38.889],
      category: "museum",
      rawCategory: "culture/museum",
    });
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
    expect(useSidebarStore.getState().activeDetailId).toBeNull();
  });

  it("uses the active-locale reverse-geocoded address for a named POI", async () => {
    fake.setRenderedFeatures("poi-label", [poiFeature()]);
    coreTest.requiredLocale = "en";
    coreTest.reverseData = { city: "Washington", address: "1000 Jefferson Drive" };
    render(<MapContextMenu />);
    openAtMapPoint();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "mapContextMenu.openPlaceDetails" }),
    );

    expect(usePlaceStore.getState().selectedPlace?.address).toBe("1000 Jefferson Drive");
  });

  it("uses canonical coordinate identity and preserves an unrelated sidebar", async () => {
    coreTest.reverseData = { city: "Washington", address: "1000 Jefferson Drive" };
    useSidebarStore.setState({ activeSidebarId: PANEL.CATEGORY });
    render(<MapContextMenu />);
    openAtMapPoint();

    await userEvent.click(
      screen.getByRole("menuitem", { name: "mapContextMenu.openPlaceDetails" }),
    );

    expect(usePlaceStore.getState().selectedPlace).toMatchObject({
      id: "coordinate:38.888590--77.025730",
      name: "Washington",
      address: "1000 Jefferson Drive",
      coordinates: [-77.02573, 38.88859],
    });
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    expect(useSidebarStore.getState().activeDetailId).toBe(PANEL.PLACE_CARD);
  });
});

describe("MapContextMenu keyboard behavior", () => {
  for (const [label, key] of [
    ["Shift+F10", { key: "F10", shiftKey: true }],
    ["ContextMenu", { key: "ContextMenu" }],
  ] as const) {
    it(`opens at the projected map center with ${label}`, () => {
      fake.state.center = { lng: 13.405, lat: 52.52 };
      fake.state.projectedPoint = { x: 30, y: 45 };
      vi.spyOn(fake.state.canvas, "getBoundingClientRect").mockReturnValue({
        top: 100,
        left: 200,
        right: 500,
        bottom: 400,
        width: 300,
        height: 300,
        x: 200,
        y: 100,
        toJSON: () => ({}),
      });
      render(<MapContextMenu />);

      fireEvent.keyDown(fake.state.canvas, key);

      expect(screen.getByText("52.520000, 13.405000")).toBeDefined();
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "mapContextMenu.fromHere" }),
      );
    });
  }

  for (const status of ["navigating", "rerouting"] as const) {
    it(`suppresses keyboard opening and native behavior without mutating state while ${status}`, () => {
      useNavigationStore.setState({ status });
      useMapClickStore.setState({ clickedLngLat: [1, 2] });
      const selectedPlace = createPlace({
        primaryScheme: "test",
        ids: { test: "kept" },
        name: "Kept place",
        address: "Kept address",
        coordinates: [3, 4],
      });
      usePlaceStore.setState({ selectedPlace });
      useSidebarStore.setState({ activeSidebarId: PANEL.CATEGORY });
      const waypointsBefore = useDirectionsStore.getState().waypoints;
      render(<MapContextMenu />);
      const event = new KeyboardEvent("keydown", {
        key: "ContextMenu",
        bubbles: true,
        cancelable: true,
      });

      fireEvent(fake.state.canvas, event);

      expect(event.defaultPrevented).toBe(true);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(useMapClickStore.getState().clickedLngLat).toEqual([1, 2]);
      expect(usePlaceStore.getState().selectedPlace).toBe(selectedPlace);
      expect(useDirectionsStore.getState().waypoints).toBe(waypointsBefore);
      expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    });
  }

  it("defines visible theme-aware focus rings for both keyboard-focused route pills", async () => {
    render(<MapContextMenu />);
    openAtMapPoint();
    const from = screen.getByRole("menuitem", { name: "mapContextMenu.fromHere" });
    const to = screen.getByRole("menuitem", { name: "mapContextMenu.toHere" });

    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(to);
    const toStyle = focusVisibleStyle(to);
    expect(toStyle?.outline.startsWith("2px solid ")).toBe(true);
    expect(toStyle?.outline.includes("transparent")).toBe(false);
    expect(toStyle?.outlineOffset).toBe("2px");

    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(from);
    const fromStyle = focusVisibleStyle(from);
    expect(fromStyle?.outline.startsWith("2px solid ")).toBe(true);
    expect(fromStyle?.outline.includes("transparent")).toBe(false);
    expect(fromStyle?.outlineOffset).toBe("2px");
  });

  it("supports roving focus, submenu return, Escape order, and canvas restoration", async () => {
    render(<MapContextMenu />);
    fireEvent.keyDown(fake.state.canvas, { key: "ContextMenu" });
    const from = screen.getByRole("menuitem", { name: "mapContextMenu.fromHere" });

    fireEvent.keyDown(from, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "mapContextMenu.toHere" }),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    const copy = screen.getByRole("menuitem", { name: "mapContextMenu.copyLocation" });
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "ArrowRight" });
    expect(screen.getAllByRole("menu", { hidden: true })).toHaveLength(2);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(1));
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(fake.state.canvas));
  });

  it("returns focus to the first action when a second invocation replaces the target", async () => {
    render(<MapContextMenu />);
    openAtMapPoint();
    const from = screen.getByRole("menuitem", { name: "mapContextMenu.fromHere" });
    fireEvent.keyDown(from, { key: "ArrowUp" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "mapContextMenu.shareLocation" }),
    );

    openAtMapPoint({ coordinates: [13.405, 52.52] });

    await waitFor(() => expect(document.activeElement).toBe(from));
  });

  it("lets an already-open menu receive a second real DOM map contextmenu", async () => {
    render(<MapContextMenu />);
    dispatchDomMapContextMenu([-77.02573, 38.88859]);
    expect(screen.getByText("38.888590, -77.025730")).toBeDefined();

    const second = dispatchDomMapContextMenu([13.405, 52.52]);

    expect(second.blockingLayer).toBe(fake.state.canvas);
    expect(second.event.defaultPrevented).toBe(true);
    expect(screen.getByText("52.520000, 13.405000")).toBeDefined();
    await userEvent.click(screen.getByRole("menuitem", { name: "mapContextMenu.fromHere" }));
    expect(useDirectionsStore.getState().origin).toEqual([13.405, 52.52]);
  });
});

describe("MapContextMenu copy behavior", () => {
  it("exposes copy submenu state on its trigger", async () => {
    render(<MapContextMenu />);
    openAtMapPoint();
    const copy = screen.getByRole("menuitem", { name: "mapContextMenu.copyLocation" });

    expect(copy.getAttribute("aria-haspopup")).toBe("menu");
    expect(copy.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(copy);

    expect(copy.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the copy submenu to the left when the right edge has insufficient room", async () => {
    render(<MapContextMenu />);
    openAtMapPoint();
    const copy = screen.getByRole("menuitem", { name: "mapContextMenu.copyLocation" });
    vi.spyOn(copy, "getBoundingClientRect").mockReturnValue({
      top: 100,
      left: 760,
      right: 1000,
      bottom: 144,
      width: 240,
      height: 44,
      x: 760,
      y: 100,
      toJSON: () => ({}),
    });

    const submenu = await openCopySubmenu();

    expect(submenu.parentElement?.style.left).toBe("760px");
  });

  it("offers exact, deduplicated coordinate, name, and address values", async () => {
    fake.setRenderedFeatures("poi-label", [poiFeature("Same value")]);
    coreTest.reverseData = { city: "Washington", address: "Same value" };
    render(<MapContextMenu />);
    openAtMapPoint();

    const submenu = await openCopySubmenu();

    expect(within(submenu).getByText("38.888590, -77.025730")).toBeDefined();
    expect(within(submenu).getAllByText("Same value")).toHaveLength(1);
    expect(within(submenu).getAllByRole("menuitem")).toHaveLength(2);
  });

  it("copies a selected exact value, closes both surfaces, and keeps success feedback", async () => {
    const writeText = installClipboard();
    render(<MapContextMenu />);
    openAtMapPoint();
    const submenu = await openCopySubmenu();

    await userEvent.click(
      within(submenu).getByRole("menuitem", { name: /38\.888590, -77\.025730/ }),
    );

    expect(writeText).toHaveBeenCalledWith("38.888590, -77.025730");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByText("mapContextMenu.copied")).toBeDefined();
  });

  it("ignores a pending copy completion after unmount", async () => {
    const pending = deferred<void>();
    installClipboard(vi.fn(() => pending.promise));
    const view = render(<MapContextMenu />);
    openAtMapPoint();
    const submenu = await openCopySubmenu();
    await userEvent.click(
      within(submenu).getByRole("menuitem", { name: /38\.888590, -77\.025730/ }),
    );
    const focusCanvas = vi.spyOn(fake.state.canvas, "focus");

    view.unmount();
    focusCanvas.mockClear();
    await act(async () => pending.resolve());
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(focusCanvas).not.toHaveBeenCalled();
  });

  it("does not let a pending copy from target A close or update target B", async () => {
    const pending = deferred<void>();
    installClipboard(vi.fn(() => pending.promise));
    render(<MapContextMenu />);
    openAtMapPoint();
    const submenu = await openCopySubmenu();
    await userEvent.click(
      within(submenu).getByRole("menuitem", { name: /38\.888590, -77\.025730/ }),
    );

    openAtMapPoint({ coordinates: [13.405, 52.52] });
    await act(async () => pending.resolve());

    expect(
      within(screen.getByRole("menu", { name: "mapContextMenu.ariaLabel" })).getByText(
        "52.520000, 13.405000",
      ),
    ).toBeDefined();
    expect(screen.queryByText("mapContextMenu.copied")).toBeNull();
  });

  for (const mode of ["rejected", "unavailable"] as const) {
    it(`keeps the main card open and shows failure when Clipboard is ${mode}`, async () => {
      if (mode === "rejected") installClipboard(vi.fn().mockRejectedValue(new Error("denied")));
      render(<MapContextMenu />);
      openAtMapPoint();
      const submenu = await openCopySubmenu();

      await userEvent.click(
        within(submenu).getByRole("menuitem", { name: /38\.888590, -77\.025730/ }),
      );

      expect(
        screen.getByRole("menu", { name: "mapContextMenu.ariaLabel", hidden: true }),
      ).toBeDefined();
      expect(screen.getByText("mapContextMenu.copyFailed")).toBeDefined();
    });
  }
});

describe("MapContextMenu share behavior", () => {
  for (const [result, remainsOpen, message] of [
    ["shared", false, null],
    ["copied", false, "mapContextMenu.linkCopied"],
    ["cancelled", false, null],
    ["unavailable", true, "mapContextMenu.shareFailed"],
  ] as const) {
    it(`handles a ${result} result without mutating application place state`, async () => {
      shareUrlMock.mockResolvedValue(result);
      window.history.replaceState({}, "", "/map?old=state#hash");
      const hrefBefore = window.location.href;
      render(<MapContextMenu />);
      openAtMapPoint();

      await userEvent.click(screen.getByRole("menuitem", { name: "mapContextMenu.shareLocation" }));

      expect(shareUrlMock).toHaveBeenCalledWith({
        title: "38.888590, -77.025730",
        url: "http://localhost:3000/map?map=38.88859%2C-77.02573%2C16%2C0%2C0&panel=place&place=coordinate%3A38.888590--77.025730&at=38.88859%2C-77.02573&name=38.888590%2C+-77.025730",
      });
      expect(Boolean(screen.queryByRole("menu"))).toBe(remainsOpen);
      if (message) expect(screen.getByText(message)).toBeDefined();
      else expect(screen.queryByText(/mapContextMenu\.(linkCopied|shareFailed)/)).toBeNull();
      expect(usePlaceStore.getState().selectedPlace).toBeNull();
      expect(window.location.href).toBe(hrefBefore);
    });
  }

  it("ignores a pending share completion after unmount", async () => {
    const pending = deferred<"copied">();
    shareUrlMock.mockImplementation(() => pending.promise);
    const view = render(<MapContextMenu />);
    openAtMapPoint();
    await userEvent.click(screen.getByRole("menuitem", { name: "mapContextMenu.shareLocation" }));
    const focusCanvas = vi.spyOn(fake.state.canvas, "focus");

    view.unmount();
    focusCanvas.mockClear();
    await act(async () => pending.resolve("copied"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(focusCanvas).not.toHaveBeenCalled();
  });

  it("does not let a pending share from target A close or update target B", async () => {
    const pending = deferred<"copied">();
    shareUrlMock.mockImplementation(() => pending.promise);
    render(<MapContextMenu />);
    openAtMapPoint();
    await userEvent.click(screen.getByRole("menuitem", { name: "mapContextMenu.shareLocation" }));

    openAtMapPoint({ coordinates: [13.405, 52.52] });
    await act(async () => pending.resolve("copied"));

    expect(screen.getByText("52.520000, 13.405000")).toBeDefined();
    expect(screen.queryByText("mapContextMenu.linkCopied")).toBeNull();
  });
});

describe("MapContextMenu dismissal and semantics", () => {
  it("does not steal focus when the map moves with no open context menu", async () => {
    render(
      <>
        <input aria-label="Outside focus target" />
        <MapContextMenu />
      </>,
    );
    const outside = screen.getByRole("textbox", { name: "Outside focus target" });
    outside.focus();

    act(() => fake.emit("movestart"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(document.activeElement).toBe(outside);
  });

  it("restores canvas focus when a style reload dismisses an open menu", async () => {
    const view = render(<MapContextMenu />);
    openAtMapPoint();

    mapContextTest.styleVersion += 1;
    view.rerender(<MapContextMenu />);

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(fake.state.canvas));
  });

  it("dismisses on outside click, map movement, and style-version change", async () => {
    const view = render(<MapContextMenu />);
    openAtMapPoint();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    fireEvent.click(fake.state.canvas);
    expect(screen.queryByRole("menu")).toBeNull();

    openAtMapPoint();
    act(() => fake.emit("movestart"));
    expect(screen.queryByRole("menu")).toBeNull();

    openAtMapPoint();
    mapContextTest.styleVersion += 1;
    view.rerender(<MapContextMenu />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("removes map and canvas listeners on unmount", () => {
    const removeKeyListener = vi.spyOn(fake.state.canvas, "removeEventListener");
    const view = render(<MapContextMenu />);

    view.unmount();

    expect([...fake.state.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
    expect(removeKeyListener.mock.calls.some(([event]) => event === "keydown")).toBe(true);
  });

  it("exposes five named top-level menu items with 44px minimum targets", () => {
    render(<MapContextMenu />);
    openAtMapPoint();

    const menu = screen.getByRole("menu", { name: "mapContextMenu.ariaLabel" });
    expect(getComputedStyle(menu).borderRadius).toBe("12px");
    expect(getComputedStyle(menu).maxWidth).toBe("1008px");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("aria-label") ?? item.textContent)).toEqual([
      "mapContextMenu.fromHere",
      "mapContextMenu.toHere",
      "mapContextMenu.copyLocation",
      "mapContextMenu.openPlaceDetails",
      "mapContextMenu.shareLocation",
    ]);
    for (const item of items) expect(getComputedStyle(item).minHeight).toBe("44px");
  });
});
