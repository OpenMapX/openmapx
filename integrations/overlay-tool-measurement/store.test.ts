import { useSettingsStore } from "@openmapx/core";
import { afterEach, describe, expect, it } from "vitest";
import { useMeasurementStore } from "./store";

describe("measurement store", () => {
  afterEach(() => {
    useMeasurementStore.getState().deactivate();
    useSettingsStore.getState().setUnits("metric");
  });

  it("starts each measurement in the units the app is set to", () => {
    useSettingsStore.getState().setUnits("imperial");
    useMeasurementStore.getState().activate();
    expect(useMeasurementStore.getState().unitSystem).toBe("imperial");

    useSettingsStore.getState().setUnits("metric");
    useMeasurementStore.getState().activate();
    expect(useMeasurementStore.getState().unitSystem).toBe("metric");
  });

  it("keeps units chosen after activating, as a shared link does", () => {
    useMeasurementStore.getState().activate();
    useMeasurementStore.getState().setUnitSystem("imperial");
    useMeasurementStore.getState().addPoint([13.4, 52.5]);
    expect(useMeasurementStore.getState().unitSystem).toBe("imperial");
  });
});
