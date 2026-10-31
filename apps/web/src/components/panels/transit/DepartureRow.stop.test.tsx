import type { MergedDeparture } from "@openmapx/mobility-core/transit";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DepartureRow } from "./DepartureRow";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: (v: string) => v.slice(11, 16) }),
}));
vi.mock("@openmapx/core", () => ({ routeColor: () => "#333333" }));

const bus: MergedDeparture = {
  tripId: "ms:b1",
  route: { id: "ms:250", shortName: "250", longName: "", mode: "bus" },
  headsign: "Bergisch Gladbach",
  scheduledAt: "2026-10-31T10:02:00Z",
  providers: ["ms"],
  stop: { id: "ms:breslauer", name: "Köln Breslauer Platz/Hbf" },
};

describe("DepartureRow stop name", () => {
  it("names the stop of a row leaving from another of the place's stops", () => {
    render(<DepartureRow departure={{ ...bus, atOtherStop: true }} />);
    expect(screen.getByText("Köln Breslauer Platz/Hbf")).toBeTruthy();
    expect(screen.getByText("transit.rowStop:")).toBeTruthy();
  });

  it("leaves rows from the place's main stop unnamed", () => {
    render(<DepartureRow departure={bus} />);
    expect(screen.queryByText("Köln Breslauer Platz/Hbf")).toBeNull();
  });
});
