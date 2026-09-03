import type { CategoryPlace } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { NearbyParkingCarousel } from "./NearbyParkingCarousel";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const mockPlaces: CategoryPlace[] = [
  {
    id: "p1",
    name: "Central Garage",
    category: "parking",
    coordinates: [10.01, 50.01],
    osmTags: { fee: "yes", parking: "multi-storey" },
  },
  {
    id: "p2",
    name: "Free Lot",
    category: "parking",
    coordinates: [10.02, 50.02],
    osmTags: { fee: "no", parking: "surface" },
  },
  {
    id: "p3",
    name: "",
    category: "parking",
    coordinates: [10.03, 50.03],
  },
];

describe("NearbyParkingCarousel", () => {
  it("renders parking facilities with Drive action", async () => {
    const onDrive = vi.fn();
    const onSelect = vi.fn();
    render(
      <NearbyParkingCarousel
        places={mockPlaces}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={onSelect}
        onDriveToPlace={onDrive}
      />,
    );
    expect(screen.getByText("Central Garage")).toBeInTheDocument();
    const driveButtons = screen.getAllByRole("button", { name: /navigation.driveHere/ });
    await userEvent.click(driveButtons[0]);
    expect(onDrive).toHaveBeenCalledWith(mockPlaces[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("handles selecting and deselecting a parking place", async () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <NearbyParkingCarousel
        places={mockPlaces}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={onSelect}
        onDriveToPlace={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByText("Central Garage"));
    expect(onSelect).toHaveBeenCalledWith(mockPlaces[0]);

    // When already selected, clicking it again passes null (deselect)
    rerender(
      <NearbyParkingCarousel
        places={mockPlaces}
        selectedPlace={mockPlaces[0]}
        isLoading={false}
        onSelectPlace={onSelect}
        onDriveToPlace={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByText("Central Garage"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("renders free and paid fee chips appropriately", () => {
    render(
      <NearbyParkingCarousel
        places={mockPlaces}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );

    expect(screen.getByText("navigation.parkingFeePaid")).toBeInTheDocument();
    expect(screen.getByText("navigation.parkingFeeFree")).toBeInTheDocument();
  });

  it("falls back to default title when place has no name", () => {
    render(
      <NearbyParkingCarousel
        places={[mockPlaces[2]]}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );

    // Header has navigation.nearbyParking (1), card has navigation.nearbyParking
    const titleElements = screen.getAllByText(/navigation.nearbyParking/);
    expect(titleElements.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a loading skeleton when isLoading and null when empty", () => {
    const { container, rerender } = render(
      <NearbyParkingCarousel
        places={mockPlaces}
        selectedPlace={null}
        isLoading={true}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );
    // Loading skeleton (role=status), not the carousel.
    expect(container.firstChild).not.toBeNull();

    rerender(
      <NearbyParkingCarousel
        places={[]}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("ignores non-canonical tags fee structure (osmTags is the contract)", () => {
    const legacyPlace = {
      id: "p4",
      name: "Legacy Lot",
      category: "parking",
      coordinates: [10.04, 50.04] as [number, number],
      tags: { fee: "yes" },
    } as unknown as CategoryPlace;

    render(
      <NearbyParkingCarousel
        places={[legacyPlace]}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );

    expect(screen.getByText("Legacy Lot")).toBeInTheDocument();
    expect(screen.queryByText("navigation.parkingFeePaid")).not.toBeInTheDocument();
  });

  it("renders parkingOptionsCount in header and previewOnMap on card accessibility label", () => {
    render(
      <NearbyParkingCarousel
        places={mockPlaces}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );

    expect(screen.getByText(/navigation.parkingOptionsCount/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /navigation.previewOnMap/ }).length,
    ).toBeGreaterThan(0);
  });

  it("uses separate preview and drive buttons without nested interactive controls", () => {
    render(
      <NearbyParkingCarousel
        places={[mockPlaces[0]]}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );

    const preview = screen.getByRole("button", { name: /navigation.previewOnMap/ });
    const drive = screen.getByRole("button", { name: /navigation.driveHere/ });
    expect(preview.parentElement?.closest("[role='button'], button")).toBeNull();
    expect(drive.parentElement?.closest("[role='button'], button")).toBeNull();
  });

  it("labels parking proximity as straight-line distance", () => {
    render(
      <NearbyParkingCarousel
        places={mockPlaces}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
        destinationCoords={[10.01, 50.01]}
      />,
    );

    expect(screen.getAllByText(/navigation.straightLineDistance/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/navigation.walkDetour/)).toBeNull();
  });
});
