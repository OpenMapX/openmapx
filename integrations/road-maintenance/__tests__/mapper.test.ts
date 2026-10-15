import type { DataSourceDetailSection } from "@openmapx/core";
import { isI18nToken, resolveToken, sharedStrings } from "@openmapx/integration-framework/strings";
import type { ServiceVehicle } from "@openmapx/mobility-core/service-vehicle";
import { describe, expect, it } from "vitest";
import { mapVehicleToDetail, mapVehicleToResult, variantOf } from "../mapper.js";
import de from "../strings/de.json";
import en from "../strings/en.json";

const AT = "2026-10-14T23:20:57Z";

function text(t: unknown, locale = "en"): string {
  if (Array.isArray(t)) return t.map((part) => text(part, locale)).join(", ");
  if (!isI18nToken(t)) return String(t);
  return resolveToken(t, {
    locale,
    fallbackLocale: "en",
    shared: sharedStrings,
    integration: { en, de },
  });
}

function rows(section: DataSourceDetailSection | undefined, locale = "en"): string[][] {
  return (section?.rows ?? []).map((row) => row.map((cell) => text(cell, locale)));
}

function vehicle(over: Partial<ServiceVehicle> = {}): ServiceVehicle {
  return {
    id: "oc:observation:fi-digitraffic-maintenance:cf0e3e74",
    coordinates: [25.507827, 65.017175],
    bearingDeg: 5,
    activity: "plowing",
    plowDown: true,
    spreaderOn: true,
    tasks: ["PLOUGHING_AND_SLUSH_REMOVAL", "SPOT_SANDING"],
    observedAt: AT,
    expiresAt: "2026-10-14T23:30:57Z",
    sources: ["fi-digitraffic-maintenance"],
    attributions: [
      {
        sourceId: "fi-digitraffic-maintenance",
        name: "Fintraffic Digitraffic road maintenance tracking",
      },
      {
        sourceId: "fi-digitraffic-maintenance",
        name: "Fintraffic Digitraffic road maintenance tracking – Harja/Väylävirasto",
        publisher: { name: "Harja/Väylävirasto" },
      },
    ],
    ...over,
  };
}

describe("mapVehicleToResult", () => {
  it("names a ploughing vehicle a snowplough and sums up its tasks", () => {
    const result = mapVehicleToResult(vehicle());
    expect(result).toMatchObject({
      id: "oc:observation:fi-digitraffic-maintenance:cf0e3e74",
      name: "",
      kind: "vehicle",
      variant: "plowing",
      source: "fi-digitraffic-maintenance",
      observedAt: AT,
    });
    expect(text(result.fallbackName)).toBe("Snowplough");
    expect(text(result.fallbackName, "de")).toBe("Räumfahrzeug");
    expect(text(result.summary)).toBe("Ploughing and slush removal and 1 more task");
    expect(text(result.summary, "de")).toBe(
      "Schneeräumen und Matschbeseitigung und 1 weitere Arbeit",
    );
  });

  it("tells ploughing, spreading and other work apart", () => {
    expect(variantOf(vehicle({ plowDown: false, activity: undefined }))).toBe("spreading");
    expect(
      variantOf(vehicle({ plowDown: undefined, spreaderOn: undefined, activity: "salting" })),
    ).toBe("spreading");
    const brushing = vehicle({
      activity: undefined,
      plowDown: undefined,
      spreaderOn: undefined,
      tasks: ["BRUSHING"],
    });
    expect(variantOf(brushing)).toBe("other");
    expect(text(mapVehicleToResult(brushing).fallbackName)).toBe("Maintenance vehicle");
    expect(variantOf({ ...brushing, tasks: ["UNKNOWN"], activity: "unknown" })).toBe("unknown");
    expect(variantOf({ ...brushing, tasks: [] })).toBe("unknown");
  });

  it("shows a task the strings do not know as the publisher writes it", () => {
    const result = mapVehicleToResult(
      vehicle({
        activity: undefined,
        plowDown: undefined,
        spreaderOn: undefined,
        tasks: ["SNOW_MELTING_WITH_LASERS"],
      }),
    );
    expect(text(result.summary)).toBe("SNOW_MELTING_WITH_LASERS");
    expect(text(mapVehicleToResult(vehicle({ tasks: [] })).summary, "de")).toBe(
      "Keine Arbeit gemeldet",
    );
  });
});

describe("mapVehicleToDetail", () => {
  it("lists the work, the tools and the heading with the time reported, then the provider", () => {
    const detail = mapVehicleToDetail(vehicle());
    expect(text(detail.fallbackName)).toBe("Snowplough");
    expect(detail.sections.map((s) => text(s.title))).toEqual(["Work", "Info"]);
    expect(rows(detail.sections[0])).toEqual([
      ["Tasks", "Ploughing and slush removal, Spot sanding"],
      ["Plough", "Down"],
      ["Spreader", "On"],
      ["Heading", "North (5°)"],
    ]);
    expect(rows(detail.sections[0], "de")[3]).toEqual(["Fahrtrichtung", "Norden (5°)"]);
    expect(detail.sections[0]).toMatchObject({ sectionIcon: "construction", captionTimestamp: AT });
    expect(rows(detail.sections[1])).toEqual([
      ["Provider", "Fintraffic Digitraffic road maintenance tracking"],
    ]);
    expect(text(detail.sections[1]?.caption)).toMatch(/anonymous/);
    expect(detail.attributions?.map((a) => a.name)).toEqual([
      "Fintraffic Digitraffic road maintenance tracking",
      "Fintraffic Digitraffic road maintenance tracking – Harja/Väylävirasto",
    ]);
  });

  it("states one task, or none, and leaves out what the vehicle does not report", () => {
    const one = mapVehicleToDetail(
      vehicle({
        tasks: ["SALTING"],
        plowDown: undefined,
        spreaderOn: undefined,
        bearingDeg: undefined,
      }),
    );
    expect(rows(one.sections[0])).toEqual([["Task", "Salting"]]);
    const none = mapVehicleToDetail(
      vehicle({ tasks: [], plowDown: undefined, spreaderOn: undefined }),
    );
    expect(rows(none.sections[0], "de")[0]).toEqual(["Arbeit", "Keine gemeldet"]);
  });

  it("labels every task of the publisher's list in both languages", () => {
    expect(Object.keys(de.task)).toEqual(Object.keys(en.task));
    expect(Object.keys(en.task)).toHaveLength(47);
  });
});
