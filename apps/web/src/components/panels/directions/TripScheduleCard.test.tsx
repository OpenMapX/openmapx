import type { TripSchedule } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", async () => {
  const { mockNextIntl } = await import("@/test/intl");
  const useTranslations = (namespace?: string) => {
    const t = (key: string, values?: Record<string, string>) => {
      const name = namespace ? `${namespace}.${key}` : key;
      return values
        ? `${name}(${Object.entries(values)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")})`
        : name;
    };
    t.rich = t;
    t.markup = t;
    t.raw = t;
    t.has = () => true;
    return t;
  };
  return mockNextIntl({ useTranslations });
});

// Pin the viewer's zone so the badge assertions do not depend on the machine
// running the suite.
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, viewerTimeZone: () => "Europe/Berlin" };
});

import { TripScheduleCard } from "./TripScheduleCard";

const schedule: TripSchedule = {
  stops: [
    {
      waypointIndex: 0,
      timeZone: "Europe/Berlin",
      departure: "2026-09-01T09:00:00+02:00",
      dwellSeconds: 0,
      waitSeconds: 0,
      utcOffsetMinutes: 120,
    },
    {
      waypointIndex: 1,
      timeZone: "Europe/Berlin",
      arrival: "2026-09-01T10:00:00+02:00",
      departure: "2026-09-01T10:30:00+02:00",
      dwellSeconds: 1800,
      waitSeconds: 0,
      utcOffsetMinutes: 120,
    },
    {
      waypointIndex: 2,
      timeZone: "America/New_York",
      arrival: "2026-09-01T12:30:00-04:00",
      dwellSeconds: 0,
      waitSeconds: 0,
      utcOffsetMinutes: -240,
    },
  ],
  legs: [],
  departure: "2026-09-01T09:00:00+02:00",
  arrival: "2026-09-01T12:30:00-04:00",
  totalTravelSeconds: 10_800,
  totalDwellSeconds: 1800,
  totalWaitSeconds: 0,
  multiDay: false,
  violations: [],
};

const labels = ["Home", "Dentist", "Airport"];

describe("TripScheduleCard", () => {
  it("renders one row per stop with its label and times", () => {
    render(
      <TripScheduleCard
        schedule={schedule}
        fidelity="exact"
        warnings={[]}
        waypointLabels={labels}
      />,
    );
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("Dentist")).toBeTruthy();
    expect(screen.getByText("Airport")).toBeTruthy();
    expect(screen.getByText("10:00 – 10:30")).toBeTruthy();
  });

  it("shows a zone badge only where the stop's zone differs from the viewer's", () => {
    render(
      <TripScheduleCard
        schedule={schedule}
        fidelity="exact"
        warnings={[]}
        waypointLabels={labels}
      />,
    );
    // The viewer sits in Europe/Berlin, so only the New York stop is off-zone.
    expect(screen.queryByText("UTC+2")).toBeNull();
    expect(screen.getByText("UTC-4")).toBeTruthy();
  });

  it("shows the stay and the wait when a stop has both", () => {
    const waiting: TripSchedule = {
      ...schedule,
      stops: schedule.stops.map((stop, index) =>
        index === 1 ? { ...stop, waitSeconds: 3600 } : stop,
      ),
      totalWaitSeconds: 3600,
    };
    render(
      <TripScheduleCard
        schedule={waiting}
        fidelity="exact"
        warnings={[]}
        waypointLabels={labels}
      />,
    );
    expect(screen.getByText(/directions\.scheduleStay/)).toBeTruthy();
    expect(screen.getByText(/directions\.scheduleWait/)).toBeTruthy();
  });

  it("renders a late arrival naming the stop and the deadline", () => {
    const late: TripSchedule = {
      ...schedule,
      violations: [
        {
          kind: "late-arrival",
          waypointIndex: 1,
          requiredBy: "2026-09-01T09:30:00+02:00",
          earliestArrival: "2026-09-01T10:00:00+02:00",
          shortfallSeconds: 1800,
        },
      ],
    };
    render(
      <TripScheduleCard schedule={late} fidelity="exact" warnings={[]} waypointLabels={labels} />,
    );
    const message = screen.getByRole("alert").textContent ?? "";
    expect(message).toContain("Dentist");
    expect(message).toContain("09:30");
  });

  it("names both ends of an unreachable leg", () => {
    const broken: TripSchedule = {
      ...schedule,
      violations: [{ kind: "unreachable", fromIndex: 0, toIndex: 1 }],
    };
    render(
      <TripScheduleCard schedule={broken} fidelity="exact" warnings={[]} waypointLabels={labels} />,
    );
    const message = screen.getByRole("alert").textContent ?? "";
    expect(message).toContain("Home");
    expect(message).toContain("Dentist");
  });

  it("warns when the travel times are approximate", () => {
    render(
      <TripScheduleCard
        schedule={schedule}
        fidelity="approximate"
        warnings={[{ kind: "approximate-travel-times", providerId: "osrm" }]}
        waypointLabels={labels}
      />,
    );
    expect(screen.getByText("directions.scheduleApproximate")).toBeTruthy();
  });

  it("renders a day divider on a multi-day trip", () => {
    const multi: TripSchedule = {
      ...schedule,
      multiDay: true,
      stops: schedule.stops.map((stop, index) =>
        index === 2 ? { ...stop, arrival: "2026-09-02T12:30:00-04:00" } : stop,
      ),
      arrival: "2026-09-02T12:30:00-04:00",
    };
    render(
      <TripScheduleCard schedule={multi} fidelity="exact" warnings={[]} waypointLabels={labels} />,
    );
    expect(screen.getAllByTestId("schedule-day-divider")).toHaveLength(1);
  });

  it("renders no divider when the trip stays on one day", () => {
    render(
      <TripScheduleCard
        schedule={schedule}
        fidelity="exact"
        warnings={[]}
        waypointLabels={labels}
      />,
    );
    expect(screen.queryAllByTestId("schedule-day-divider")).toHaveLength(0);
  });
});
