import { contributorsForField } from "@openmapx/mobility-core/contributors";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test";
import { prepareVehicleTransition, toFeature, vehicleMapContributors } from "../map-layer";
import { LiveTransitPopup } from "../popup";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const receipt = (name: string) => ({ sourceId: name, name, url: `https://example.com/${name}` });
const vehicle = {
  id: "bus",
  sourceId: "feed",
  mode: "bus" as const,
  displayLabel: "42",
  lat: 50,
  lng: 6,
  updatedAt: "2026-10-15T18:00:00Z",
  positionKind: "observed" as const,
  speedKmh: 20,
  color: "#123456",
  contributors: [receipt("Vehicle capture")],
  alerts: ["First alert", "Second alert", "Hidden alert"].map((title) => ({
    id: title,
    title,
    severity: "warning" as const,
    affectedRouteIds: [],
    affectedStopIds: [],
    contributors: [receipt(title)],
  })),
};

describe("live transit surface ownership", () => {
  it("credits the vehicle, without alerts invisible on its marker", () => {
    const contributors = JSON.parse(toFeature(vehicle).properties._mapAttributions);
    expect(contributors.map((a: { name: string }) => a.name)).toEqual(["Vehicle capture"]);
  });
  it("separates visible icon, label and on-route ring fields", () => {
    const feature = toFeature({
      ...vehicle,
      fieldContributors: {
        lat: [receipt("Position")],
        lng: [receipt("Position")],
        mode: [receipt("Mode")],
        bearing: [receipt("Bearing")],
        positionKind: [receipt("Estimate")],
        displayLabel: [receipt("Label")],
        tripId: [receipt("Trip")],
        speed: [receipt("Hidden speed")],
      },
    });
    const names = (layer: string) =>
      vehicleMapContributors({ properties: feature.properties, layer: { id: layer } }).map(
        (r) => r.name,
      );
    expect(names("live-transit-icon")).toEqual(["Position", "Mode", "Bearing", "Estimate"]);
    expect(names("live-transit-label")).toEqual(["Position", "Label"]);
    expect(names("live-transit-onroute-ring")).toEqual(["Position", "Trip"]);
  });
  it("retains old and new receipts for blended position and speed until animation completes", () => {
    const previous = {
      ...vehicle,
      lat: 40,
      lng: 2,
      speed: 2,
      bearing: 10,
      contributors: [receipt("Old capture")],
    };
    const target = { ...vehicle, speed: 4, bearing: 30, contributors: [receipt("New capture")] };
    const transition = prepareVehicleTransition(previous, target);
    const frame = transition(0.5);
    expect(frame.lat).toBe(45);
    expect(frame.lng).toBe(4);
    expect(frame.speed).toBe(3);
    expect(contributorsForField(frame, "lat").map((r) => r.name)).toEqual([
      "Old capture",
      "New capture",
    ]);
    expect(contributorsForField(frame, "speed").map((r) => r.name)).toEqual([
      "Old capture",
      "New capture",
    ]);
    expect(contributorsForField(frame, "displayLabel").map((r) => r.name)).toEqual(["New capture"]);
    expect(contributorsForField(transition(0), "lat").map((r) => r.name)).toEqual(["Old capture"]);
    expect(transition(1)).toBe(target);
    expect(
      prepareVehicleTransition(previous, { ...target, contributors: previous.contributors })(0.5)
        .fieldContributors,
    ).toBeUndefined();
  });
  it("credits mode-derived popup color but not a hidden classification notice", () => {
    render(
      <LiveTransitPopup
        vehicle={{
          ...vehicle,
          alerts: [],
          fieldContributors: {
            displayLabel: [receipt("Badge label")],
            mode: [receipt("Badge mode")],
            updatedAt: [receipt("Timestamp")],
            positionKind: [receipt("Hidden classification")],
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "attributions" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Badge mode")).toBeVisible();
    expect(within(dialog).queryByText("Hidden classification")).toBeNull();
  });
  it("shows captured vehicle and exactly the visible alert receipts in popup details", () => {
    render(<LiveTransitPopup vehicle={vehicle} />);
    expect(screen.queryByText("Hidden alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "attributions" }));
    const dialog = screen.getByRole("dialog");
    for (const name of ["Vehicle capture", "First alert", "Second alert"])
      expect(within(dialog).getByText(name)).toBeVisible();
    expect(within(dialog).queryByText("Hidden alert")).toBeNull();
  });
});
