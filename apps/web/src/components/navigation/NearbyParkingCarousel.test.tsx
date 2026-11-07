import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { NearbyParkingCarousel } from "./NearbyParkingCarousel";
import type { NearbyParkingPlace } from "./nearbyParking";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const resolver = vi.hoisted(() => ({ integrationId: undefined as string | undefined }));
vi.mock("@/components/panels/place/useDataSourceI18nResolver", () => ({
  useDataSourceI18nResolver: (integrationId: string | undefined) => {
    resolver.integrationId = integrationId;
    return (value: unknown) =>
      value && typeof value === "object" && "$t" in value ? `resolved ${String(value.$t)}` : "";
  },
}));

const mockPlaces: NearbyParkingPlace[] = [
  {
    id: "p1",
    name: "Central Garage",
    category: "parking",
    coordinates: [10.01, 50.01],
    fee: "paid",
  },
  {
    id: "p2",
    name: "Free Lot",
    category: "parking",
    coordinates: [10.02, 50.02],
    fee: "free",
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
    expect(screen.getByText("navigation.parkingFeePaid")).toBeInTheDocument();
    expect(screen.getByText("navigation.parkingFeeFree")).toBeInTheDocument();
    expect(screen.getByText(/navigation.parkingOptionsCount/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "navigation.nearbyParking — navigation.previewOnMap" }),
    ).toBeInTheDocument();
    const preview = screen.getByRole("button", {
      name: "Central Garage — navigation.previewOnMap",
    });
    expect(preview.parentElement?.closest("[role='button'], button")).toBeNull();
    const driveButtons = screen.getAllByRole("button", { name: /navigation.driveHere/ });
    expect(driveButtons[0].parentElement?.closest("[role='button'], button")).toBeNull();
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
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("article")).toBeNull();

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
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a fee only from the candidate's own fee, not from raw tags", () => {
    const legacyPlace: NearbyParkingPlace = {
      id: "p4",
      name: "Legacy Lot",
      category: "parking",
      coordinates: [10.04, 50.04],
      osmTags: { fee: "yes" },
    };

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

  it("shows the parking source's free-space line in the parking strings", () => {
    render(
      <NearbyParkingCarousel
        places={[{ ...mockPlaces[0], summary: { $t: "summary.spaces", values: { count: 12 } } }]}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );

    expect(screen.getByText("resolved summary.spaces")).toBeInTheDocument();
    expect(resolver.integrationId).toBe("parking");
  });

  it("marks a car park kept for customers", () => {
    render(
      <NearbyParkingCarousel
        places={[{ ...mockPlaces[0], access: "customers" }, mockPlaces[1]]}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
      />,
    );

    expect(screen.getAllByText("navigation.parkingCustomersOnly")).toHaveLength(1);
  });

  it("shows the measured walk to the destination instead of the straight-line distance", () => {
    render(
      <NearbyParkingCarousel
        places={[
          {
            ...mockPlaces[0],
            walk: { seconds: 250, meters: 320, contributors: [] },
          },
          mockPlaces[1],
        ]}
        selectedPlace={null}
        isLoading={false}
        onSelectPlace={vi.fn()}
        onDriveToPlace={vi.fn()}
        destinationCoords={[10.01, 50.01]}
      />,
    );

    const [measured, straight] = screen.getAllByRole("article");
    expect(measured).toHaveTextContent("navigation.parkingWalkToDestination");
    expect(measured).not.toHaveTextContent("navigation.straightLineDistance");
    expect(straight).toHaveTextContent("navigation.straightLineDistance");
  });

  it("starts from the first card when the order changes, so the best one is in view", () => {
    const props = {
      selectedPlace: null,
      isLoading: false,
      onSelectPlace: vi.fn(),
      onDriveToPlace: vi.fn(),
    };
    const { rerender } = render(<NearbyParkingCarousel {...props} places={mockPlaces} />);
    const scroller = screen.getAllByRole("article")[0]?.parentElement;
    if (!scroller) throw new Error("Expected the card scroller");
    const scrolledTo = vi.fn();
    Object.defineProperty(scroller, "scrollLeft", { configurable: true, set: scrolledTo });

    rerender(<NearbyParkingCarousel {...props} places={[...mockPlaces]} />);
    expect(scrolledTo).not.toHaveBeenCalled();
    rerender(<NearbyParkingCarousel {...props} places={[...mockPlaces].reverse()} />);
    expect(scrolledTo).toHaveBeenCalledWith(0);
  });

  it("keeps a selected card in view through a new order, and reveals a card chosen on the map", () => {
    const reveal = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      reveal(this.getAttribute("data-parking-id"));
    };
    try {
      const props = { isLoading: false, onSelectPlace: vi.fn(), onDriveToPlace: vi.fn() };
      const { rerender } = render(
        <NearbyParkingCarousel {...props} places={mockPlaces} selectedPlace={null} />,
      );
      reveal.mockClear();
      rerender(
        <NearbyParkingCarousel {...props} places={mockPlaces} selectedPlace={mockPlaces[2]} />,
      );
      expect(reveal).toHaveBeenLastCalledWith("p3");
      reveal.mockClear();
      rerender(
        <NearbyParkingCarousel
          {...props}
          places={[...mockPlaces].reverse()}
          selectedPlace={mockPlaces[2]}
        />,
      );
      expect(reveal).toHaveBeenCalledWith("p3");
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
