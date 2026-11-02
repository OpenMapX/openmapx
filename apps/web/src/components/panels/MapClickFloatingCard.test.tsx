// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
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
const share = vi.hoisted(() => ({ shareUrl: vi.fn(async () => "copied" as const) }));
vi.mock("@/lib/deepLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deepLink")>()),
  shareUrl: share.shareUrl,
}));

import { PANEL, useDirectionsStore, useMapClickStore, useSidebarStore } from "@openmapx/core";
import { MapClickFloatingCard } from "./MapClickFloatingCard";

const PIN: [number, number] = [6.083, 50.776];

function asPhone(phone: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

beforeEach(() => {
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
  beforeEach(() => asPhone(true));

  it("offers the context menu's actions as a row", () => {
    render(<MapClickFloatingCard />);
    for (const name of [
      "place.directions",
      "mapContextMenu.fromHere",
      "common.share",
      "parking.saveParking",
      "common.copy",
      "common.details",
    ]) {
      expect(screen.getByRole("button", { name })).toBeDefined();
    }
  });

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
    expect(await screen.findByText("mapContextMenu.linkCopied")).toBeDefined();
  });

  it("saves parking at the pin", async () => {
    render(<MapClickFloatingCard />);
    await userEvent.click(screen.getByRole("button", { name: "parking.saveParking" }));
    expect(parking.saveAt).toHaveBeenCalledWith(PIN, { address: "Marktplatz 1" });
    await waitFor(() => expect(useMapClickStore.getState().clickedLngLat).toBeNull());
  });
});

describe("MapClickFloatingCard on a desktop", () => {
  beforeEach(() => asPhone(false));

  it("keeps the compact card without the action row", () => {
    render(<MapClickFloatingCard />);
    expect(screen.getByRole("button", { name: "place.directions" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "mapContextMenu.fromHere" })).toBeNull();
  });
});
