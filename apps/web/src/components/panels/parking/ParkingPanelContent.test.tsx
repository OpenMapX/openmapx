import { useParkingStore, useSidebarStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

const state = vi.hoisted(() => ({
  parked: [] as unknown[],
  vehicles: [] as unknown[],
  update: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useParkedLocations: () => ({ data: state.parked }),
  useVehicles: () => ({ data: state.vehicles }),
  useUpdateParkedLocation: () => ({ mutate: state.update, isPending: false }),
  useClearParkedLocation: () => ({ mutate: state.clear, isPending: false }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { ParkingPanelContent } from "./ParkingPanelContent";

const RECORD = {
  id: "p1",
  vehicleId: null,
  lat: 51.55,
  lng: 6.6,
  address: "Am Kuhteich 42",
  note: null,
  expiresAt: null,
  source: "manual",
  accuracyMeters: 8,
  savedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  state.parked = [RECORD];
  state.vehicles = [];
  state.update.mockReset();
  state.clear.mockReset();
  useParkingStore.getState().reset();
  useSidebarStore.setState({ activeSidebarId: "parking", activeDetailId: null });
});

describe("ParkingPanelContent", () => {
  it("shows the captured address and when it was saved", () => {
    render(<ParkingPanelContent />);
    expect(screen.getByText("Am Kuhteich 42")).toBeInTheDocument();
    expect(screen.getByText(/parking.savedWhen/)).toBeInTheDocument();
  });

  it("closes the sidebar when there is nothing to show", async () => {
    state.parked = [];
    render(<ParkingPanelContent />);
    await waitFor(() => expect(useSidebarStore.getState().activeSidebarId).toBeNull());
  });

  it("clears the record and closes", async () => {
    render(<ParkingPanelContent />);
    await userEvent.click(screen.getByRole("button", { name: /parking.clear/ }));
    expect(state.clear).toHaveBeenCalledWith("p1");
  });

  it("arms the map picker for Change location", async () => {
    render(<ParkingPanelContent />);
    await userEvent.click(screen.getByRole("button", { name: /parking.changeLocation/ }));
    expect(useParkingStore.getState().picking).toBe(true);
  });

  it("commits a picked coordinate and disarms", async () => {
    render(<ParkingPanelContent />);
    useParkingStore.getState().setPickedCoords([6.7, 51.6]);
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p1", lat: 51.6, lng: 6.7 }),
      ),
    );
    await waitFor(() => expect(useParkingStore.getState().pickedCoords).toBeNull());
  });

  it("marks an elapsed expiry as expired", () => {
    state.parked = [{ ...RECORD, expiresAt: new Date(Date.now() - 60_000).toISOString() }];
    render(<ParkingPanelContent />);
    expect(screen.getByText("parking.expired")).toBeInTheDocument();
  });

  it("shows the remaining time for a future expiry", () => {
    state.parked = [{ ...RECORD, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }];
    render(<ParkingPanelContent />);
    expect(screen.getByText(/parking.timeLeft/)).toBeInTheDocument();
  });

  it("names the vehicle when the record has one", () => {
    state.vehicles = [{ id: "v1", name: "Blue Golf", isDefault: true }];
    state.parked = [{ ...RECORD, vehicleId: "v1" }];
    render(<ParkingPanelContent />);
    expect(screen.getByText(/parking.forVehicle/)).toBeInTheDocument();
  });
});
