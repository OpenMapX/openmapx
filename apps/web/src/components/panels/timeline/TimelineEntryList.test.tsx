import type { PersonalTimelineDayV1 } from "@openmapx/core";
import { usePersonalTimelineStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, userEvent, within } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { TimelineEntryList } from "./TimelineEntryList";

const day: PersonalTimelineDayV1 = {
  version: 1,
  date: "2026-08-09",
  timeZone: "Europe/Berlin",
  distanceUnit: "km",
  summary: { totalDistance: 12.5, placesVisited: 1, movingMinutes: 30, stationaryMinutes: 90 },
  bounds: [13.3, 52.4, 13.5, 52.6],
  entries: [
    {
      type: "journey",
      id: "journey-1",
      startedAt: "2026-08-09T10:00:00.000Z",
      endedAt: "2026-08-09T10:30:00.000Z",
      durationSeconds: 1800,
      distance: 12.5,
      distanceUnit: "km",
      dominantMode: "cycling",
      averageSpeed: 25,
      speedUnit: "km/h",
      elevationGain: 42,
      elevationLoss: 0,
    },
    {
      type: "visit",
      id: "visit-1",
      name: null,
      status: "confirmed",
      startedAt: "2026-08-09T08:00:00.000Z",
      endedAt: "2026-08-09T09:30:00.000Z",
      durationMinutes: 90,
      pointCount: 5,
      tags: ["coffee", "work"],
      location: { longitude: 13.4, latitude: 52.5 },
    },
    {
      type: "journey",
      id: "journey-minimal",
      startedAt: "2026-08-09T12:00:00.000Z",
      endedAt: "2026-08-09T12:10:00.000Z",
      durationSeconds: 600,
      distanceUnit: "km",
      dominantMode: null,
    },
  ],
  map: {
    tracks: { type: "FeatureCollection", features: [] },
    visits: { type: "FeatureCollection", features: [] },
  },
  capabilities: { trackGeometry: true, elevation: true },
  warnings: [],
};

afterEach(() => {
  act(() => usePersonalTimelineStore.getState().resetForSession());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TimelineEntryList", () => {
  it("sorts chronologically and renders visit and journey values without inventing optionals", () => {
    render(<TimelineEntryList day={day} />);
    const list = screen.getByRole("list", { name: "timeline.entriesAriaLabel" });
    const entries = within(list).getAllByRole("button");

    expect(entries.map((entry) => entry.getAttribute("data-entry-id"))).toEqual([
      "visit-1",
      "journey-1",
      "journey-minimal",
    ]);
    const visit = screen.getByRole("button", { name: /timeline.visitFallback/ });
    expect(visit).toHaveTextContent("90 min");
    expect(visit).toHaveTextContent("5");
    expect(screen.getByText("coffee")).toBeInTheDocument();
    expect(screen.getByText("cycling")).toBeInTheDocument();
    expect(screen.getByText("12.5 km")).toBeInTheDocument();
    expect(screen.getByText("25 km/h")).toBeInTheDocument();
    expect(screen.getByText("timeline.elevationGain: 42 m")).toBeInTheDocument();
    expect(screen.getByText("timeline.elevationLoss: 0 m")).toBeInTheDocument();

    const minimal = screen.getByRole("button", { name: /timeline.journeyFallback/ });
    expect(minimal).not.toHaveTextContent("0 km");
    expect(minimal).not.toHaveTextContent("0 km/h");
  });

  it.each(["{Enter}", " "])(
    "selects a card button with %s and exposes pressed state",
    async (key) => {
      const user = userEvent.setup();
      render(<TimelineEntryList day={day} />);
      const visit = screen.getByRole("button", { name: /timeline.visitFallback/ });
      visit.focus();

      await user.keyboard(key);

      expect(usePersonalTimelineStore.getState().selectedEntryId).toBe("visit-1");
      expect(visit).toHaveAttribute("aria-pressed", "true");
    },
  );

  it("scrolls a map-selected card with reduced-motion-safe behavior", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const { rerender } = render(<TimelineEntryList day={day} />);

    act(() => usePersonalTimelineStore.getState().selectEntry("journey-1"));
    rerender(<TimelineEntryList day={day} />);

    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "nearest" });
  });
});
