import type { DataSourceDetailSection } from "@openmapx/core";
import { isI18nToken, resolveToken, sharedStrings } from "@openmapx/integration-framework/strings";
import type { BorderCrossing, BorderCrossingQueue } from "@openmapx/mobility-core/border-crossing";
import { describe, expect, it } from "vitest";
import { mapCrossingToDetail, mapCrossingToResult, variantOf, waitOf } from "../mapper.js";
import de from "../strings/de.json";
import en from "../strings/en.json";

const CBP_AT = "2026-10-14T23:27:00Z";
const CBSA_AT = "2026-10-14T23:20:00Z";

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

function queue(over: Partial<BorderCrossingQueue> & Pick<BorderCrossingQueue, "key">) {
  return {
    mode: "passenger",
    status: "delay",
    stale: false,
    ...over,
  } as BorderCrossingQueue;
}

/** The Peace Bridge as both agencies publish it: CBSA into Canada, CBP into the US. */
function peaceBridge(over: Partial<BorderCrossing> = {}): BorderCrossing {
  return {
    id: "oc:feature:ca-cbsa-waits:peace-bridge",
    name: "Peace Bridge",
    coordinates: [-78.9056, 42.9069],
    countries: ["CA", "US"],
    location: "Fort Erie, ON/Buffalo, NY",
    open: "open",
    queues: [
      queue({
        key: "commercial",
        mode: "commercial",
        from: "US",
        to: "CA",
        waitMinutes: 11,
        updatedAt: CBSA_AT,
      }),
      queue({ key: "passenger", from: "US", to: "CA", waitMinutes: 2, updatedAt: CBSA_AT }),
      queue({
        key: "us-cbp-waits/commercial/standard",
        mode: "commercial",
        program: "standard",
        from: "CA",
        to: "US",
        status: "no_delay",
        waitMinutes: 6,
        lanesOpen: 4,
        updatedAt: CBP_AT,
      }),
      queue({
        key: "us-cbp-waits/passenger/trusted_traveller",
        program: "trusted_traveller",
        from: "CA",
        to: "US",
        status: "no_delay",
        waitMinutes: 0,
        lanesOpen: 1,
        updatedAt: CBP_AT,
      }),
      queue({
        key: "us-cbp-waits/passenger/standard",
        program: "standard",
        from: "CA",
        to: "US",
        waitMinutes: 25,
        lanesOpen: 1,
        updatedAt: CBP_AT,
      }),
      queue({
        key: "us-cbp-waits/passenger/ready_lane",
        program: "ready_lane",
        from: "CA",
        to: "US",
        status: "closed",
        updatedAt: CBP_AT,
      }),
    ],
    sources: ["ca-cbsa-waits", "us-cbp-waits"],
    attributions: [
      { sourceId: "ca-cbsa-waits", name: "CBSA border wait times" },
      { sourceId: "us-cbp-waits", name: "CBP border wait times" },
    ],
    ...over,
  };
}

/** Douglas, Arizona, as CBP alone publishes it. */
function douglas(over: Partial<BorderCrossing> = {}): BorderCrossing {
  return {
    id: "oc:feature:us-cbp-waits:260101",
    name: "Douglas (Raul Hector Castro)",
    coordinates: [-109.56, 31.3347],
    countries: ["MX", "US"],
    open: "open",
    openingHours: "24/7",
    queues: [
      queue({
        key: "commercial/standard",
        mode: "commercial",
        program: "standard",
        from: "MX",
        to: "US",
        status: "closed",
      }),
      queue({
        key: "passenger/standard",
        program: "standard",
        from: "MX",
        to: "US",
        waitMinutes: 60,
        lanesOpen: 4,
      }),
      queue({
        key: "pedestrian/standard",
        mode: "pedestrian",
        program: "standard",
        from: "MX",
        to: "US",
        status: "no_delay",
        waitMinutes: 3,
        lanesOpen: 2,
      }),
    ],
    sources: ["us-cbp-waits"],
    attributions: [{ sourceId: "us-cbp-waits", name: "CBP border wait times" }],
    ...over,
  };
}

describe("mapCrossingToResult", () => {
  it("colours a crossing by the cars' longest wait and sums up each direction", () => {
    const result = mapCrossingToResult(peaceBridge());
    expect(result).toMatchObject({
      variant: "moderate",
      status: "operational",
      sortValues: { waitMinutes: 25 },
      observedAt: CBP_AT,
      sources: ["ca-cbsa-waits", "us-cbp-waits"],
    });
    expect(text(result.summary)).toBe("Into Canada: 2 min · Into the US: 25 min");
    expect(text(result.summary, "de")).toBe("Nach Kanada: 2 Min. · In die USA: 25 Min.");
  });

  it("sums up a one-way crossing by its cars, trucks and pedestrians", () => {
    const result = mapCrossingToResult(douglas());
    expect(result).toMatchObject({ variant: "long", sortValues: { waitMinutes: 60 } });
    expect(text(result.summary)).toBe("Cars: 1 h · Pedestrians: 3 min");
    expect(text(result.summary, "de")).toBe("Pkw: 1 Std. · Fußgänger: 3 Min.");
  });

  it("bands waits at 15 and 45 minutes, and a no-delay without minutes is short", () => {
    const band = (q: Partial<BorderCrossingQueue>) =>
      variantOf(douglas({ queues: [queue({ key: "p", to: "US", ...q })] }));
    expect(band({ waitMinutes: 15 })).toBe("short");
    expect(band({ waitMinutes: 16 })).toBe("moderate");
    expect(band({ waitMinutes: 45 })).toBe("moderate");
    expect(band({ waitMinutes: 46 })).toBe("long");
    expect(band({ status: "no_delay" })).toBe("short");
    expect(band({ status: "delay" })).toBe("moderate");
    expect(band({ status: "unknown" })).toBe("unknown");
    expect(band({ waitMinutes: 90, stale: true })).toBe("unknown");
  });

  it("speaks for the trucks when no car lane states a wait", () => {
    const trucks = douglas({
      queues: [
        queue({ key: "c", mode: "commercial", to: "US", waitMinutes: 50 }),
        queue({ key: "p", to: "US", status: "unknown" }),
      ],
    });
    expect(variantOf(trucks)).toBe("long");
  });

  it("dims a closed crossing, whether stated closed or every queue closed", () => {
    const stated = mapCrossingToResult(douglas({ open: "closed" }));
    expect(stated).toMatchObject({ variant: "closed", status: "non-operational" });
    expect(stated.sortValues).toBeUndefined();
    expect(text(stated.summary, "de")).toBe("Geschlossen");
    const lanes = douglas({
      open: undefined,
      queues: [queue({ key: "p", to: "US", status: "closed" })],
    });
    expect(variantOf(lanes)).toBe("closed");
  });

  it("says when no wait is current", () => {
    const stale = mapCrossingToResult(
      douglas({ queues: [queue({ key: "p", to: "US", waitMinutes: 5, stale: true })] }),
    );
    expect(stale).toMatchObject({ variant: "unknown", status: "unknown" });
    expect(stale.observedAt).toBeUndefined();
    expect(text(stale.summary)).toBe("No current wait times");
  });
});

describe("waitOf", () => {
  it("states minutes, hours and minutes, or what the queue is instead", () => {
    const of = (q: Partial<BorderCrossingQueue>, locale = "en") =>
      text(waitOf(queue({ key: "p", ...q })), locale);
    expect(of({ waitMinutes: 0 })).toBe("0 min");
    expect(of({ waitMinutes: 95 })).toBe("1 h 35 min");
    expect(of({ waitMinutes: 95 }, "de")).toBe("1 Std. 35 Min.");
    expect(of({ status: "no_delay" })).toBe("No delay");
    expect(of({ status: "delay" })).toBe("Delays");
    expect(of({ status: "closed" }, "de")).toBe("Geschlossen");
    expect(of({ status: "unknown" })).toBe("Not stated");
    expect(of({ waitMinutes: 5, stale: true })).toBe("No current wait");
  });
});

describe("mapCrossingToDetail", () => {
  it("lists each direction's queues, cars first, with the lanes open and when they were stated", () => {
    const detail = mapCrossingToDetail(peaceBridge());
    expect(detail.sections.map((s) => text(s.title))).toEqual([
      "Into Canada",
      "Into the United States",
      "Info",
    ]);
    expect(rows(detail.sections[0])).toEqual([
      ["Cars", "2 min"],
      ["Trucks", "11 min"],
    ]);
    expect(detail.sections[0]).toMatchObject({ captionTimestamp: CBSA_AT });
    expect(rows(detail.sections[1])).toEqual([
      ["Cars", "25 min · 1 lane open"],
      ["Cars, NEXUS/SENTRI", "0 min · 1 lane open"],
      ["Cars, Ready Lane", "Closed"],
      ["Trucks", "6 min · 4 lanes open"],
    ]);
    expect(rows(detail.sections[1], "de")[3]).toEqual(["Lkw", "6 Min. · 4 Spuren offen"]);
    expect(text(detail.sections[1]?.title, "de")).toBe("Einreise in die USA");
    expect(rows(detail.sections[2])).toEqual([
      ["Status", "Open"],
      ["Location", "Fort Erie, ON/Buffalo, NY"],
      ["Providers", "CBSA border wait times, CBP border wait times"],
    ]);
  });

  it("carries the crossing's opening hours to the place", () => {
    expect(mapCrossingToDetail(douglas()).openingHours).toBe("24/7");
    expect(mapCrossingToDetail(peaceBridge())).not.toHaveProperty("openingHours");
  });

  it("names a direction into a country the strings do not by its code", () => {
    const detail = mapCrossingToDetail(
      douglas({ queues: [queue({ key: "p", to: "GT", waitMinutes: 5 })] }),
    );
    expect(text(detail.sections[0]?.title)).toBe("Into GT");
  });

  it("says so when a crossing publishes no queue", () => {
    const detail = mapCrossingToDetail(douglas({ queues: [], open: undefined }));
    expect(text(detail.sections[0]?.content)).toBe(
      "No wait times are published for this crossing.",
    );
  });

  it("every string has its German", () => {
    const keys = (o: object, prefix = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === "object" && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    expect(keys(de)).toEqual(keys(en));
  });
});
