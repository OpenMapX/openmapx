import { useStreetLevelStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test";
import StreetLevelViewerInner from "./StreetLevelViewerInner";

const fixture = vi.hoisted(() => ({
  env: { apiUrl: "https://api.test" },
  flyTo: vi.fn(),
  receipt: {
    sourceId: "installed-style",
    name: "Installed style supplier",
    attributionText: "Exact installed style notice",
    url: "https://supplier.test/captured-terms",
  },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => fixture.env }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: fixture.flyTo }) }));
vi.mock("@/components/search/SearchBar", () => ({ SearchBar: () => null }));
vi.mock("./StreetLevelInfoCard", () => ({ StreetLevelInfoCard: () => null }));
vi.mock("./StreetLevelFlatImage", () => ({ StreetLevelFlatImage: () => <div>Street image</div> }));
vi.mock("@/integration-api/components/useStreetLevelProviders", () => ({
  useStreetLevelProviders: () => ({ providers: [] }),
}));
vi.mock("./useStreetLevelNode", () => ({
  fetchStreetLevelNode: async () => ({
    id: "provider:one",
    image: {
      id: "one",
      providerId: "provider",
      lngLat: [6, 51],
      isPano: false,
      assets: { sd: "https://image.test/frame" },
    },
    arrows: [],
  }),
}));
// WebGL is unavailable in jsdom. Exercise the installed-style ownership handoff
// at the minimap boundary; LocationMinimap.test covers the real acquisition.
vi.mock("@/integration-api/components/LocationMinimap", () => ({
  LocationMinimap: ({
    onCreditsChange,
    onClick,
  }: {
    onCreditsChange?: (credits: readonly Attribution[]) => void;
    onClick: () => void;
  }) => {
    useEffect(() => {
      onCreditsChange?.([fixture.receipt]);
      return () => onCreditsChange?.([]);
    }, [onCreditsChange]);
    return (
      <button type="button" onClick={onClick} aria-label="Return to map">
        {!onCreditsChange && <span>Credits covering minimap</span>}
      </button>
    );
  },
}));

beforeEach(() => {
  fixture.flyTo.mockClear();
  useStreetLevelStore.setState({
    activeImage: { providerId: "provider", imageId: "one" },
    acceptedProviders: [],
  });
});
it("places the installed minimap receipts in associated viewer UI outside the tiny map", async () => {
  const view = render(<StreetLevelViewerInner />);
  const minimap = await screen.findByRole("button", { name: "Return to map" });
  expect(screen.queryByText("Credits covering minimap")).toBeNull();
  const notice = await screen.findByText("Exact installed style notice");
  expect(minimap.contains(notice)).toBe(false);
  view.rerender(<StreetLevelViewerInner />);
  expect(screen.getAllByText("Exact installed style notice")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "credits" }));
  expect(screen.getByRole("link", { name: "Installed style supplier" })).toHaveAttribute(
    "href",
    "https://supplier.test/captured-terms",
  );
  fireEvent.click(screen.getByRole("button", { name: "close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(minimap);
  expect(fixture.flyTo).toHaveBeenCalledWith([6, 51], 18);
  expect(useStreetLevelStore.getState().activeImage).toBeNull();
});
