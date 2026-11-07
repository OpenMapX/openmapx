// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor, within } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    flyTo: vi.fn(),
    mapRef: { current: { project: () => ({ x: 120, y: 140 }) } },
  }),
}));
const basemap = vi.hoisted(() => ({
  poi: null as null | {
    featureId: string;
    name: string;
    coordinates: [number, number];
    category?: string;
  },
}));
vi.mock("@/components/map/mapStylePoiTarget", () => ({
  getStylePoiLayerIds: () => ["poi-label"],
  findStylePoiAtPoint: () => basemap.poi,
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useReverseGeocoding: () => ({
    data: { address: "Marktplatz 1", city: "Aachen" },
    isLoading: false,
  }),
}));
const parking = vi.hoisted(() => ({ saveAt: vi.fn(async () => "saved" as const) }));
vi.mock("@/components/panels/parking/useSaveParking", () => ({
  useSaveParking: () => ({ saveAt: parking.saveAt, saveHere: vi.fn(), isSaving: false }),
}));
const share = vi.hoisted(() => ({
  shareUrl: vi.fn(async (..._args: unknown[]) => "copied" as const),
}));
vi.mock("@/lib/deepLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deepLink")>()),
  shareUrl: share.shareUrl,
}));

import {
  PANEL,
  useDirectionsStore,
  useMapClickStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { MapClickFloatingCard } from "./MapClickFloatingCard";

const PIN: [number, number] = [6.083, 50.776];

function asDevice(device: "phone" | "touch tablet" | "desktop"): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      (device === "phone" && query.includes("max-width")) ||
      (device !== "desktop" && query.includes("pointer: coarse")),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

beforeEach(() => {
  basemap.poi = null;
  usePlaceStore.getState().setSelectedPlace(null);
  useMapClickStore.getState().setClickedLngLat(PIN);
  useDirectionsStore.getState().close();
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  parking.saveAt.mockClear();
  share.shareUrl.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MapClickFloatingCard on a phone", () => {
  beforeEach(() => asDevice("phone"));

  it("starts a route from the pin", async () => {
    render(<MapClickFloatingCard />);
    await userEvent.click(screen.getByRole("button", { name: "mapContextMenu.fromHere" }));
    const directions = useDirectionsStore.getState();
    expect(directions.isOpen).toBe(true);
    expect(directions.waypoints[0].coords).toEqual(PIN);
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.DIRECTIONS);
    expect(useMapClickStore.getState().clickedLngLat).toBeNull();
  });

  it("shares a link to the pin and says when it was copied instead", async () => {
    render(<MapClickFloatingCard />);
    await userEvent.click(screen.getByRole("button", { name: "common.share" }));
    expect(share.shareUrl).toHaveBeenCalledTimes(1);
    const payload = share.shareUrl.mock.calls[0]?.[0] as unknown as { url: string; title: string };
    expect(new URL(payload.url).searchParams.get("at")).toBe("50.776,6.083");
    expect(payload.title).toBe("Aachen");
    expect(await screen.findByText("mapContextMenu.linkCopied")).toBeDefined();
  });

  it("saves parking at the pin", async () => {
    render(<MapClickFloatingCard />);
    await userEvent.click(screen.getByRole("button", { name: "parking.saveParking" }));
    expect(parking.saveAt).toHaveBeenCalledWith(PIN, { address: "Marktplatz 1" });
    await waitFor(() => expect(useMapClickStore.getState().clickedLngLat).toBeNull());
  });
});

describe("MapClickFloatingCard on a touch screen wider than a phone", () => {
  beforeEach(() => asDevice("touch tablet"));

  it("starts a route from a pin on a touch tablet", async () => {
    render(<MapClickFloatingCard />);
    expect(screen.getByRole("button", { name: "common.share" })).toBeDefined();
    expect(screen.getByRole("button", { name: "parking.saveParking" })).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "mapContextMenu.fromHere" }));
    expect(useDirectionsStore.getState().waypoints[0].coords).toEqual(PIN);
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.DIRECTIONS);
  });
});

describe("MapClickFloatingCard's Copy", () => {
  beforeEach(() => asDevice("phone"));

  it("offers the coordinates and the address, as the right-click menu does", async () => {
    const writeText = installClipboard();
    render(<MapClickFloatingCard />);
    await userEvent.click(screen.getByRole("button", { name: "common.copy" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("50.776000, 6.083000")).toBeDefined();
    await userEvent.click(within(menu).getByText("Marktplatz 1"));
    expect(writeText).toHaveBeenCalledWith("Marktplatz 1");
    expect(await screen.findByText("mapContextMenu.copied")).toBeDefined();
  });
});

describe("MapClickFloatingCard on a basemap place", () => {
  beforeEach(() => {
    asDevice("phone");
    basemap.poi = {
      featureId: "42",
      name: "Café Kaiser",
      coordinates: [6.0831, 50.7761],
      category: "cafe",
    };
  });

  it("names the place and opens it, as right-click does", async () => {
    render(<MapClickFloatingCard />);
    expect(screen.getByText("Café Kaiser")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "common.details" }));
    const selected = usePlaceStore.getState().selectedPlace;
    expect(selected?.name).toBe("Café Kaiser");
    expect(selected?.id).toBe("stylePoi:42");
  });

  it("offers its name to copy", async () => {
    const writeText = installClipboard();
    render(<MapClickFloatingCard />);
    await userEvent.click(screen.getByRole("button", { name: "common.copy" }));
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByText("Café Kaiser"));
    expect(writeText).toHaveBeenCalledWith("Café Kaiser");
  });

  it("routes to it under its name", async () => {
    render(<MapClickFloatingCard />);
    await userEvent.click(screen.getByRole("button", { name: "mapContextMenu.fromHere" }));
    expect(useDirectionsStore.getState().waypoints[0].label).toBe("Café Kaiser");
  });
});

describe("MapClickFloatingCard on a desktop", () => {
  beforeEach(() => asDevice("desktop"));

  it("keeps the compact card without the action row", () => {
    render(<MapClickFloatingCard />);
    expect(screen.getByRole("button", { name: "place.directions" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "mapContextMenu.fromHere" })).toBeNull();
  });
});
