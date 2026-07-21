import { describe, expect, it } from "vitest";
import { chargeSecondsFor } from "./charging.js";

const base = { batteryKwh: 75, chargerPowerKw: 150, vehicleMaxKw: 150, taperSocPct: 80 };

describe("chargeSecondsFor", () => {
  it("charges below taper at constant effective power", () => {
    // 0 -> 37.5 kWh (0->50%) at min(150,150)=150kW => 0.25h = 900s
    const s = chargeSecondsFor({ ...base, fromSocKwh: 0, toSocKwh: 37.5 });
    expect(s).toBeCloseTo(900, -1);
  });
  it("is capped by the slower of charger and vehicle acceptance", () => {
    const slow = chargeSecondsFor({ ...base, chargerPowerKw: 50, fromSocKwh: 0, toSocKwh: 25 });
    expect(slow).toBeCloseTo(1800, -1); // 25kWh / 50kW = 0.5h
  });
  it("charging into the taper region takes disproportionately longer", () => {
    const belowTaper = chargeSecondsFor({ ...base, fromSocKwh: 0, toSocKwh: 15 }); // 20%
    const aboveTaper = chargeSecondsFor({ ...base, fromSocKwh: 60, toSocKwh: 75 }); // 80->100%
    expect(aboveTaper).toBeGreaterThan(belowTaper * 2);
  });
});
