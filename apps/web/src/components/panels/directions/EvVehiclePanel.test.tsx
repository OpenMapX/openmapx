import { useSettingsStore } from "@openmapx/core";
import { listVehicles } from "@openmapx/ev-charge-planner";
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

  it("virtualizes the listbox and groups options by make", async () => {
    const user = userEvent.setup();
    render(<EvVehiclePanel />);
    await user.click(screen.getByLabelText("directions.ev.vehicle"));

    // Only a screenful of the 1091 options is mounted at a time.
    const mounted = await screen.findAllByRole("option");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(40);

    // The custom vehicle heads the list under its own heading, then the makes.
    expect(mounted[0].textContent).toBe("directions.ev.customVehicle");
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

    // Twenty steps down from an unhighlighted list is the twentieth option: the
    // custom vehicle plus the first nineteen dataset entries.
    await user.keyboard("{Enter}");
    expect(useSettingsStore.getState().evVehicleId).toBe(listVehicles()[18].id);
  });

  it("hides the custom form for a dataset vehicle", async () => {
    render(<EvVehiclePanel />);
    await pickVehicle("Volkswagen ID.4 PRO (2024)");
    expect(screen.queryByLabelText("directions.ev.customBattery")).toBeNull();
  });
});
