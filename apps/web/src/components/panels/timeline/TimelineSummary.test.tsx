import type { PersonalTimelineDayV1 } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { TimelineSummary } from "./TimelineSummary";

describe("TimelineSummary", () => {
  it("renders all normalized day totals with locale-aware values", () => {
    const summary: PersonalTimelineDayV1["summary"] = {
      totalDistance: 12.5,
      placesVisited: 3,
      movingMinutes: 45,
      stationaryMinutes: 615,
    };

    render(<TimelineSummary summary={summary} distanceUnit="km" />);

    expect(screen.getByText("12.5 km")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("45 min")).toBeInTheDocument();
    expect(screen.getByText("615 min")).toBeInTheDocument();
    expect(screen.getByText("timeline.summary.distance")).toBeInTheDocument();
    expect(screen.getByText("timeline.summary.places")).toBeInTheDocument();
  });
});
