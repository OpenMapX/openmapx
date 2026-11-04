import { render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  account: "a" as string | null,
  places: [{ id: "p", name: "Place", lng: 13, lat: 52 }],
  send: vi.fn(),
}));
vi.mock("@openmapx/core", () => ({
  useSession: () => ({
    data: state.account ? { user: { id: state.account } } : null,
    isPending: false,
  }),
  useCarSavedPlaces: () => ({ data: state.places }),
  useDirectionsStore: () => ({ avoidHighways: true, avoidTolls: false, avoidFerries: false }),
  useSettingsStore: () => ({
    units: "imperial",
    voiceGuidanceTiming: "normal",
    avoidIncidents: true,
  }),
  useNavigationStore: () => ({ voiceEnabled: true, keepScreenOn: true }),
}));
vi.mock("next-intl", () => ({ useLocale: () => "de" }));
vi.mock("@/stores/recentSearchStore", () => ({
  useRecentSearchStore: () => [],
  scopeRecentDestinations: () => [],
}));
vi.mock("./MobileRuntimeProvider", () => ({
  useMobileRuntimeContext: () => ({
    state: "native-compatible",
    handshake: { capabilities: { carDestinations: true } },
    client: { send: state.send },
  }),
}));

import { CarDestinationsPublisher } from "./CarDestinationsPublisher";

beforeEach(() => {
  state.account = "a";
  state.send.mockClear();
});
it("publishes only bounded coordinates and settings, and explicitly clears on sign-out", () => {
  const view = render(<CarDestinationsPublisher />);
  expect(state.send).toHaveBeenLastCalledWith(
    "destinations.update",
    expect.objectContaining({
      account: "a",
      locale: "de",
      units: "imperial",
      saved: [{ id: "p", label: "Place", coordinates: [13, 52] }],
    }),
  );
  state.account = null;
  view.rerender(<CarDestinationsPublisher />);
  expect(state.send).toHaveBeenLastCalledWith(
    "destinations.update",
    expect.objectContaining({ account: null, saved: [], recent: [] }),
  );
});
