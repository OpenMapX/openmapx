import type { TripLeg } from "@openmapx/mobility-core/transit";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TransitJourneyToolbar } from "./TransitJourneyToolbar";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const ride = (name: string): TripLeg => ({
  mode: "bus",
  route: { shortName: name, longName: "" },
  from: { name: "A", lat: 0, lng: 0 },
  to: { name: "B", lat: 0, lng: 1 },
  startTime: "",
  endTime: "",
  geometry: {
    type: "LineString",
    coordinates: [
      [0, 0],
      [1, 0],
    ],
  },
});
it("exposes one details control and summarizes current and remaining services", () => {
  const toggle = vi.fn();
  const legs = [ride("12"), ride("21"), ride("51"), ride("RE1"), ride("42")];
  const view = render(
    <TransitJourneyToolbar
      legs={legs}
      currentLegIndex={1}
      expanded={false}
      onToggle={toggle}
      mobile
    />,
  );
  const button = screen.getByRole("button", { name: "navigation.resizePanel" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("12")).toBeNull();
  expect(screen.getByText("21")).toBeInTheDocument();
  expect(screen.getByText("51")).toBeInTheDocument();
  expect(screen.getByText("navigation.moreJourneyLegs")).toBeInTheDocument();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(button);
  expect(toggle).toHaveBeenCalledTimes(1);
  view.rerender(
    <TransitJourneyToolbar legs={legs} currentLegIndex={1} expanded onToggle={toggle} mobile />,
  );
  expect(button).toHaveAttribute("aria-expanded", "true");
});
