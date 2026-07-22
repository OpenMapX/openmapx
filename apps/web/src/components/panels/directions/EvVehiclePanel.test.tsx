import { useSettingsStore } from "@openmapx/core";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_VEHICLE_ID } from "@/lib/buildEvDirectionsRequest";
import { fireEvent, render, screen, waitFor } from "@/test";
import { EvVehiclePanel } from "./EvVehiclePanel";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

async function pickVehicle(label: string) {
  const user = userEvent.setup();
  const input = screen.getByLabelText("directions.ev.vehicle");
  await user.click(input);
  await user.type(input, label);
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("EvVehiclePanel", () => {
  beforeEach(() => {
    useSettingsStore.setState({ evVehicleId: null, evCustomVehicle: null });
  });

  it("picks a dataset vehicle by its display name", async () => {
    render(<EvVehiclePanel />);
    await pickVehicle("Volkswagen ID.4 PRO (2024)");
    expect(useSettingsStore.getState().evVehicleId).toBe("volkswagen:id_4:2024:id_4");
  });

  it("saves a hand-entered spec when the custom vehicle is chosen", async () => {
    render(<EvVehiclePanel />);
    await pickVehicle("directions.ev.customVehicle");
    expect(useSettingsStore.getState().evVehicleId).toBe(CUSTOM_VEHICLE_ID);

    fireEvent.change(screen.getByLabelText("directions.ev.customBattery"), {
      target: { value: "64" },
    });
    fireEvent.change(screen.getByLabelText("directions.ev.customConsumption"), {
      target: { value: "170" },
    });
    fireEvent.change(screen.getByLabelText("directions.ev.customMaxDc"), {
      target: { value: "150" },
    });
    fireEvent.change(screen.getByLabelText("directions.ev.customMaxAc"), {
      target: { value: "11" },
    });

    // The write is debounced so typing does not fire a plan request per keystroke.
    expect(useSettingsStore.getState().evCustomVehicle).toBeNull();

    await waitFor(
      () => {
        const spec = useSettingsStore.getState().evCustomVehicle;
        expect(spec?.batteryKwh).toBe(64);
        expect(spec?.baseWhPerKm).toBe(170);
        expect(spec?.maxDcKw).toBe(150);
        expect(spec?.maxAcKw).toBe(11);
        expect(spec?.connectors.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
  });

  it("does not save a spec with a non-positive battery", async () => {
    render(<EvVehiclePanel />);
    await pickVehicle("directions.ev.customVehicle");
    fireEvent.change(screen.getByLabelText("directions.ev.customBattery"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("directions.ev.customConsumption"), {
      target: { value: "170" },
    });
    fireEvent.change(screen.getByLabelText("directions.ev.customMaxDc"), {
      target: { value: "150" },
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(useSettingsStore.getState().evCustomVehicle).toBeNull();
  });

  it("hides the custom form for a dataset vehicle", async () => {
    render(<EvVehiclePanel />);
    await pickVehicle("Volkswagen ID.4 PRO (2024)");
    expect(screen.queryByLabelText("directions.ev.customBattery")).toBeNull();
  });
});
