import type { TransitStop } from "@openmapx/mobility-core/transit";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LineDetail } from "./LineDetail";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const stops = vi.hoisted(() => [
  { id: "otdch:bern", name: "Bern", lat: 46.949, lng: 7.439, sequence: 1 },
  { id: "otdch:thun", name: "Thun", sequence: 2 },
  { id: "otdch:spiez", name: "Spiez", lat: 46.686, lng: 7.68, sequence: 3 },
]);
vi.mock("@openmapx/core", () => ({
  routeColor: () => "#0055aa",
  useLinkedTransitStops: () => ({ data: undefined }),
  useRouteAlerts: () => ({ data: [] }),
  useRouteStops: () => ({ data: stops, isLoading: false }),
  useTransitRoute: () => ({
    data: { id: "otdch:ic6", shortName: "IC6", longName: "Spiez", mode: "rail" },
    isLoading: false,
  }),
}));

const currentStop: TransitStop = {
  id: "otdch:bern",
  name: "Bern",
  lat: 46.949,
  lng: 7.439,
  modes: ["rail"],
  provider: "otdch",
};

describe("LineDetail stop list", () => {
  it("lists a stop without coordinates in order but does not offer it as a place", () => {
    const onSelectStop = vi.fn();
    render(
      <LineDetail
        routeId="otdch:ic6"
        currentStop={currentStop}
        onBack={() => {}}
        onSelectStop={onSelectStop}
      />,
    );

    const rows = screen.getAllByRole("button", { name: /Bern|Thun|Spiez/ });
    expect(rows.map((row) => row.textContent)).toEqual(["Bern", "Thun", "Spiez"]);
    expect(screen.getByRole("button", { name: "Thun" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Thun" }));
    expect(onSelectStop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Spiez" }));
    expect(onSelectStop).toHaveBeenCalledWith(
      expect.objectContaining({ id: "otdch:spiez", lat: 46.686, lng: 7.68 }),
    );
  });
});
