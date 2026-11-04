import { apiClient, useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const capture = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("@/lib/mobile/transitCapture", () => ({ prepareTransitStart: capture.prepare }));

import { TransitAlternativesDialog } from "./TransitAlternativesDialog";

const trip = (): TripItinerary => ({
  duration: 600,
  startTime: "2026-11-04T10:00:00Z",
  endTime: "2026-11-04T10:10:00Z",
  transfers: 0,
  walkDistance: 0,
  legs: [
    {
      mode: "bus",
      tripId: "selected",
      route: { shortName: "12", longName: "Bus 12" },
      startTime: "2026-11-04T10:00:00Z",
      endTime: "2026-11-04T10:10:00Z",
      from: { name: "A", lat: 0, lng: 0 },
      to: { name: "B", lat: 0, lng: 0.02 },
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [0.02, 0],
        ],
      },
    },
  ],
});
function start() {
  const s = useNavigationStore.getState();
  s.startTransitNavigation(trip(), { wheelchairRequired: true, modes: ["BUS"] });
  s.applyTransitProgress({
    currentLegIndex: 0,
    phase: "waiting-to-board",
    snapped: [0, 0],
    position: [0, 0],
    positionTimestampMs: Date.now(),
    fractionAlongLeg: 0,
    deviationMeters: 0,
    arrived: false,
  });
}
afterEach(() => {
  useNavigationStore.getState().stopNavigation();
  vi.restoreAllMocks();
  capture.prepare.mockReset();
});
it("keeps the selected journey while querying and displaying alternatives", async () => {
  start();
  const original = useNavigationStore.getState().itinerary;
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: { itineraries: [trip()] } });
  render(<TransitAlternativesDialog open onClose={() => {}} />);
  await screen.findByRole("button", { name: "navigation.useTransitJourney" });
  expect(useNavigationStore.getState().itinerary).toBe(original);
  expect(capture.prepare).not.toHaveBeenCalled();
});
it("does not adopt a captured alternative after the actual location becomes stale", async () => {
  start();
  const original = useNavigationStore.getState().itinerary;
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: { itineraries: [{ ...trip(), id: "alternative" }] },
  });
  let finish: (v: unknown) => void = () => {};
  capture.prepare.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  render(<TransitAlternativesDialog open onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "navigation.useTransitJourney" }));
  await waitFor(() => expect(capture.prepare).toHaveBeenCalledTimes(1));
  act(() =>
    useNavigationStore.setState((s) =>
      s.transitProgress
        ? {
            transitProgress: { ...s.transitProgress, positionTimestampMs: Date.now() - 31000 },
          }
        : {},
    ),
  );
  await act(async () => finish({ ok: true, startPackage: { captures: [] } }));
  expect(useNavigationStore.getState().itinerary).toBe(original);
});
