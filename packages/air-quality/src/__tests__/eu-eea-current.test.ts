import { describe, expect, it } from "vitest";
import fixtures from "../__fixtures__/eea-eaqi.json";
import {
  calculateEeaIndex,
  classifyEeaPollutant,
  EEA_CATEGORIES,
  euEeaCurrentAdapter,
} from "../standards/eu-eea-current";

describe("EEA European AQI", () => {
  it("matches the independently transcribed threshold fixture", () => {
    for (const [pollutant, value, level] of fixtures.boundaryCases) {
      expect(classifyEeaPollutant(pollutant as "pm25", value as number)).toBe(level);
    }
    expect(EEA_CATEGORIES.map(({ id, rasterValue }) => [id, rasterValue])).toEqual([
      ["good", 1],
      ["fair", 2],
      ["moderate", 3],
      ["poor", 4],
      ["very-poor", 5],
      ["extremely-poor", 6],
    ]);
  });

  it("selects the worst pollutant and retains ties", () => {
    expect(
      calculateEeaIndex(
        [
          { pollutant: "no2", valueUgM3: 80 },
          { pollutant: "pm25", valueUgM3: 70 },
        ],
        "traffic",
      ),
    ).toMatchObject({ level: 4, dominantPollutants: ["no2", "pm25"], qualified: true });
  });

  it("applies traffic and background/industrial qualification separately", () => {
    const no2AndPm = [
      { pollutant: "no2" as const, valueUgM3: 20 },
      { pollutant: "pm10" as const, valueUgM3: 20 },
    ];
    expect(calculateEeaIndex(no2AndPm, "traffic")?.qualified).toBe(true);
    expect(calculateEeaIndex(no2AndPm, "background")).toBeNull();
    expect(
      calculateEeaIndex([...no2AndPm, { pollutant: "o3", valueUgM3: 80 }], "industrial")?.qualified,
    ).toBe(true);
  });

  it("returns only poor-or-worse partial results", () => {
    expect(calculateEeaIndex([{ pollutant: "pm25", valueUgM3: 30 }], "traffic")).toBeNull();
    expect(calculateEeaIndex([{ pollutant: "pm25", valueUgM3: 60 }], "traffic")).toMatchObject({
      level: 4,
      qualified: false,
      partialAlert: true,
    });
  });

  it("never gap-fills SO2 and marks other filled station evidence hybrid", () => {
    const base = [
      { pollutant: "no2" as const, valueUgM3: 20 },
      { pollutant: "pm25" as const, valueUgM3: 10 },
    ];
    expect(
      calculateEeaIndex(
        [...base, { pollutant: "so2", valueUgM3: 300, gapFilled: true }],
        "traffic",
      ),
    ).toMatchObject({ level: 2, basis: "ground" });
    expect(calculateEeaIndex([{ ...base[0], gapFilled: true }, base[1]], "traffic")?.basis).toBe(
      "hybrid",
    );
  });

  it("requires hourly concentration intervals for the current adapter", () => {
    const make = (pollutant: "no2" | "pm25", durationMinutes: number) => ({
      seriesId: pollutant,
      coherenceKey: "one",
      pollutant,
      sensorId: null,
      spatialSupportId: "station",
      cadenceMinutes: durationMinutes,
      originalUnit: "ug/m3",
      samples: [
        {
          startAt: new Date(
            Date.parse("2026-08-30T12:00:00Z") - durationMinutes * 60_000,
          ).toISOString(),
          endAt: "2026-08-30T12:00:00Z",
          value: 10,
          unit: "ug/m3" as const,
          valid: true,
          estimated: false,
          gapFilled: false,
        },
      ],
    });
    const input = {
      observationId: "obs",
      outputIndexId: "idx",
      evaluatedAt: "2026-08-30T12:00:00Z",
      mode: "current" as const,
      stationType: "traffic" as const,
    };

    expect(
      euEeaCurrentAdapter.calculate?.({ ...input, series: [make("no2", 60), make("pm25", 60)] }),
    ).toMatchObject({ ok: true });
    expect(
      euEeaCurrentAdapter.calculate?.({ ...input, series: [make("no2", 15), make("pm25", 60)] }),
    ).toMatchObject({ ok: false, reason: "missing_required_pollutant" });
  });
});
