import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

const state = vi.hoisted(() => ({
  vehicles: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useVehicles: () => ({ data: state.vehicles }),
  useCreateVehicle: () => ({ mutate: state.create, isPending: false }),
  useUpdateVehicle: () => ({ mutate: state.update, isPending: false }),
  useDeleteVehicle: () => ({ mutate: state.remove, isPending: false }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { VehiclesDialog } from "./VehiclesDialog";

const CAR = {
  id: "v1",
  name: "Blue Golf",
  kind: "car",
  powertrain: "petrol",
  isDefault: true,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 6.4,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

beforeEach(() => {
  state.vehicles = [CAR];
  state.create.mockReset();
  state.update.mockReset();
  state.remove.mockReset();
});

describe("VehiclesDialog", () => {
  it("lists the garage", () => {
    render(<VehiclesDialog open onClose={() => {}} />);
    expect(screen.getByText("Blue Golf")).toBeInTheDocument();
  });

  it("shows an empty state for an empty garage", () => {
    state.vehicles = [];
    render(<VehiclesDialog open onClose={() => {}} />);
    expect(screen.getByText("vehicles.empty")).toBeInTheDocument();
  });

  it("creates a combustion vehicle", async () => {
    state.vehicles = [];
    render(<VehiclesDialog open onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
    await userEvent.type(screen.getByLabelText("vehicles.name"), "Red Polo");
    await userEvent.click(screen.getByRole("button", { name: "vehicles.save" }));
    await waitFor(() =>
      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Red Polo", kind: "car" }),
      ),
    );
  });

  it("refuses to save a vehicle with no name", async () => {
    state.vehicles = [];
    render(<VehiclesDialog open onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
    expect(screen.getByRole("button", { name: "vehicles.save" })).toBeDisabled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("refuses to save an electric vehicle with an incomplete battery spec", async () => {
    state.vehicles = [];
    render(<VehiclesDialog open onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "vehicles.add" }));
    await userEvent.type(screen.getByLabelText("vehicles.name"), "Silent One");
    await userEvent.click(screen.getByLabelText("vehicles.powertrain"));
    await userEvent.click(screen.getByRole("option", { name: "vehicles.powertrainElectric" }));
    expect(screen.getByRole("button", { name: "vehicles.save" })).toBeDisabled();
  });

  it("hides Add once the cap is reached", () => {
    state.vehicles = Array.from({ length: 12 }, (_, i) => ({ ...CAR, id: `v${i}`, name: `V${i}` }));
    render(<VehiclesDialog open onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "vehicles.add" })).toBeNull();
    expect(screen.getByText(/vehicles.limitReached/)).toBeInTheDocument();
  });

  it("promotes a vehicle to default", async () => {
    state.vehicles = [CAR, { ...CAR, id: "v2", name: "Red Polo", isDefault: false }];
    render(<VehiclesDialog open onClose={() => {}} />);
    await userEvent.click(screen.getAllByRole("radio")[1]);
    expect(state.update).toHaveBeenCalledWith({ id: "v2", isDefault: true });
  });

  it("warns that deleting clears the parked position and waits for confirmation", async () => {
    render(<VehiclesDialog open onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "vehicles.delete" }));
    expect(screen.getByText("vehicles.deleteWarning")).toBeInTheDocument();
    expect(state.remove).not.toHaveBeenCalled();
  });
});
