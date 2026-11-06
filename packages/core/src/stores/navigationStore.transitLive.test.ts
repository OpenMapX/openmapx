import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { afterEach, expect, it } from "vitest";
import { useNavigationStore } from "./navigationStore";

const trip: TripItinerary = {
  legs: [],
  duration: 0,
  startTime: "",
  endTime: "",
  transfers: 0,
  walkDistance: 0,
  refreshToken: "unused",
};
afterEach(() => {
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().setConnectivity("online");
  useNavigationStore.setState({ navigationAuthority: "browser" });
});

it("preserves offline connectivity on transit start and replacement", () => {
  const store = useNavigationStore.getState();
  store.setConnectivity("offline");
  store.startTransitNavigation(trip);
  expect(useNavigationStore.getState()).toMatchObject({
    connectivity: "offline",
    liveDataUnavailable: true,
  });
  store.replaceItinerary(trip);
  expect(useNavigationStore.getState()).toMatchObject({
    connectivity: "offline",
    liveDataUnavailable: true,
  });
});

it("binds broken refresh chains to the active browser session and resets them on replacement", () => {
  const store = useNavigationStore.getState();
  store.startTransitNavigation(trip);
  const id = useNavigationStore.getState().transitRequestId;
  store.markTransitRefreshUnavailable(null);
  store.markTransitRefreshUnavailable("obsolete");
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
  useNavigationStore.setState({ navigationAuthority: "native" });
  store.markTransitRefreshUnavailable(id);
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
  useNavigationStore.setState({ navigationAuthority: "browser" });
  store.markTransitRefreshUnavailable(id);
  store.setLiveDataUnavailable(false);
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(true);
  store.replaceItinerary(trip);
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
  store.markTransitRefreshUnavailable(id);
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
  store.markTransitRefreshUnavailable(useNavigationStore.getState().transitRequestId);
  store.completeArrival();
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
  store.markTransitRefreshUnavailable(useNavigationStore.getState().transitRequestId);
  expect(useNavigationStore.getState().transitRefreshUnavailable).toBe(false);
});
