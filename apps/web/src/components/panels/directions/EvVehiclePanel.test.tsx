import { useSettingsStore } from "@openmapx/core";
import { listVehicles } from "@openmapx/ev-charge-planner";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";

const garage = vi.hoisted(() => ({ vehicles: [] as unknown[] }));

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useVehicles: () => ({ data: garage.vehicles }),
}));

vi.mock("@/components/settings/VehiclesDialog", () => ({
  VehiclesDialog: ({ open }: { open: boolean }) => (open ? <div>vehicles-dialog-open</div> : null),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { EvVehiclePanel } from "./EvVehiclePanel";

const GARAGE_EV = {
  id: "v1",
  name: "Blue Leaf",
  kind: "car",
  powertrain: "electric",
  isDefault: true,
  presetId: null,
  ev: {
    batteryKwh: 64,
    baseWhPerKm: 170,
    massTonnes: 2,
    maxDcKw: 150,
    maxAcKw: 11,
    vehicleTaperSocPct: 80,
    connectors: ["ccs2"],
  },
  fuelConsumptionLPer100Km: null,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

async function pickVehicle(label: string) {
  const user = userEvent.setup();
  const input = screen.getByLabelText("directions.ev.vehicle");
  await user.click(input);
  await user.type(input, label);
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("EvVehiclePanel", () => {
  beforeEach(() => {
    garage.vehicles = [];
    useSettingsStore.setState({ evVehicleId: null });
  });

  it("picks a dataset vehicle by its display name", async () => {
    render(<EvVehiclePanel />);
    await pickVehicle("Volkswagen ID.4 PRO (2024)");
    expect(useSettingsStore.getState().evVehicleId).toBe("volkswagen:id_4:2024:id_4");
  });

  it("lists garage vehicles ahead of the dataset", async () => {
    garage.vehicles = [GARAGE_EV];
    render(<EvVehiclePanel />);
    await pickVehicle("Blue Leaf");
    expect(useSettingsStore.getState().evVehicleId).toBe("garage:v1");
  });

  it("omits a garage vehicle that has no battery spec", async () => {
    const user = userEvent.setup();
    garage.vehicles = [{ ...GARAGE_EV, id: "v2", name: "Blue Golf", ev: null }];
    render(<EvVehiclePanel />);
    await user.click(screen.getByLabelText("directions.ev.vehicle"));
    await screen.findAllByRole("option");
    expect(screen.queryByRole("option", { name: "Blue Golf" })).toBeNull();
  });

  it("opens the garage from the picker", async () => {
    const user = userEvent.setup();
    render(<EvVehiclePanel />);
    await user.click(screen.getByRole("button", { name: "vehicles.add" }));
    expect(screen.getByText("vehicles-dialog-open")).toBeInTheDocument();
  });

  it("virtualizes the listbox and groups options by make", async () => {
    const user = userEvent.setup();
    garage.vehicles = [GARAGE_EV];
    render(<EvVehiclePanel />);
    await user.click(screen.getByLabelText("directions.ev.vehicle"));

    // Only a screenful of the 1091 options is mounted at a time.
    const mounted = await screen.findAllByRole("option");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(40);

    // The garage heads the list under its own heading, then the makes.
    expect(mounted[0].textContent).toBe("Blue Leaf");
    expect(screen.getByText("Audi").textContent).toBe("Audi");
  });

  it("scrolls the virtual window to keep the keyboard highlight mounted", async () => {
    const user = userEvent.setup();
    render(<EvVehiclePanel />);
    const input = screen.getByLabelText("directions.ev.vehicle");
    await user.click(input);
    await screen.findAllByRole("option");

    for (let i = 0; i < 20; i += 1) await user.keyboard("{ArrowDown}");

    // The highlight has run past the first screenful, so the option it points at
    // is only in the DOM if the virtual window followed it.
    const highlighted = input.getAttribute("aria-activedescendant");
    expect(highlighted).not.toBeNull();
    expect(document.getElementById(highlighted as string)).not.toBeNull();

    // With an empty garage the list is the dataset alone, so twenty steps down
    // from an unhighlighted list lands on the twentieth dataset entry.
    await user.keyboard("{Enter}");
    expect(useSettingsStore.getState().evVehicleId).toBe(listVehicles()[19].id);
  });
});
