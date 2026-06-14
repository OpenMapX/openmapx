import type { TransportMode } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import {
  buildStopIdentity,
  calculateDelaySeconds,
  collectStopModes,
  datePartFromIso,
  decodeServiceJourneyId,
  dedupeById,
  encodeServiceJourneyId,
  ensureClosedRing,
  formatTransportModes,
  humanizeNsrEnum,
  isQuayId,
  isTruthyString,
  normalizeColor,
  normalizeLine,
  normalizeStopPlace,
  nsrCoordinatesFromPosList,
  nsrPrivateCodeValue,
  nsrRefValue,
  nsrTextValue,
  parkingKindFromVehicleTypes,
  pickLocalizedText,
  shiftDate,
  stripKnownPrefix,
  toAlertSeverity,
  toOccupancyLevel,
  toTransportMode,
} from "./provider.js";

describe("stripKnownPrefix", () => {
  it.each([
    ["entur:NSR:Quay:1", "NSR:Quay:1"],
    ["entur:NSR:StopPlace:337", "NSR:StopPlace:337"],
    ["nsr:StopPlace:337", "NSR:StopPlace:337"],
    ["nsr:Quay:99", "NSR:Quay:99"],
    ["NSR:StopPlace:1", "NSR:StopPlace:1"],
    ["RUT:Line:5", "RUT:Line:5"],
    ["", ""],
  ])("strips/canonicalizes %j -> %j", (input, expected) => {
    expect(stripKnownPrefix(input)).toBe(expected);
  });

  it("only strips a leading entur: prefix, not embedded occurrences", () => {
    expect(stripKnownPrefix("entur:entur:NSR:Quay:1")).toBe("entur:NSR:Quay:1");
  });
});

describe("buildStopIdentity", () => {
  it("marks NSR ids with the nsr primary scheme and both ids", () => {
    expect(buildStopIdentity("NSR:StopPlace:337")).toEqual({
      primaryScheme: "nsr",
      ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
    });
  });

  it("falls back to the entur scheme for non-NSR ids", () => {
    expect(buildStopIdentity("RUT:Quay:7")).toEqual({
      primaryScheme: "entur",
      ids: { entur: "RUT:Quay:7" },
    });
  });
});

describe("encodeServiceJourneyId / decodeServiceJourneyId", () => {
  it.each([
    ["RUT:ServiceJourney:1", "2026-03-10", "entur:2026-03-10|RUT:ServiceJourney:1"],
    ["RUT:ServiceJourney:1", undefined, "entur:RUT:ServiceJourney:1"],
    ["RUT:ServiceJourney:1", "not-a-date", "entur:RUT:ServiceJourney:1"],
    ["RUT:ServiceJourney:1", "2026-3-10", "entur:RUT:ServiceJourney:1"],
  ])("encode(%j, %j) -> %j", (id, date, expected) => {
    expect(encodeServiceJourneyId(id, date)).toBe(expected);
  });

  it.each([
    [
      "entur:2026-03-10|RUT:ServiceJourney:1",
      { date: "2026-03-10", serviceJourneyId: "RUT:ServiceJourney:1" },
    ],
    ["entur:RUT:ServiceJourney:1", { serviceJourneyId: "RUT:ServiceJourney:1" }],
    ["nsr:Quay:1", { serviceJourneyId: "NSR:Quay:1" }],
    ["entur:bad-date|RUT:ServiceJourney:1", { serviceJourneyId: "bad-date|RUT:ServiceJourney:1" }],
  ])("decode(%j)", (token, expected) => {
    expect(decodeServiceJourneyId(token)).toEqual(expected);
  });

  it.each([
    ["RUT:ServiceJourney:1", "2026-03-10"],
    ["RUT:ServiceJourney:42", undefined],
    ["ABC:ServiceJourney:9", "1999-12-31"],
  ])("round-trips decode(encode(%j, %j))", (id, date) => {
    const decoded = decodeServiceJourneyId(encodeServiceJourneyId(id, date));
    expect(decoded.serviceJourneyId).toBe(id);
    expect(decoded.date).toBe(date);
  });
});

describe("isQuayId", () => {
  it.each([
    ["NSR:Quay:1", true],
    ["entur:NSR:Quay:1", true],
    ["NSR:StopPlace:337", false],
    ["RUT:Line:5", false],
  ])("isQuayId(%j) -> %s", (input, expected) => {
    expect(isQuayId(input)).toBe(expected);
  });
});

describe("isTruthyString", () => {
  it.each([
    ["hello", true],
    [" x ", true],
    ["", false],
    ["   ", false],
    [null, false],
    [undefined, false],
  ])("isTruthyString(%j) -> %s", (input, expected) => {
    expect(isTruthyString(input)).toBe(expected);
  });
});

describe("toTransportMode", () => {
  it.each<[string | null | undefined, TransportMode]>([
    ["rail", "rail"],
    ["RAIL", "rail"],
    ["metro", "subway"],
    ["tram", "tram"],
    ["water", "ferry"],
    ["ferry", "ferry"],
    ["lift", "gondola"],
    ["cableway", "cable_car"],
    ["funicular", "funicular"],
    ["monorail", "monorail"],
    ["coach", "bus"],
    ["bus", "bus"],
    ["foot", "walking"],
    ["unknown", "bus"],
    [null, "bus"],
    [undefined, "bus"],
  ])("toTransportMode(%j) -> %s", (input, expected) => {
    expect(toTransportMode(input)).toBe(expected);
  });
});

describe("collectStopModes", () => {
  it("maps transport modes and dedupes", () => {
    expect(collectStopModes(["rail", "metro", "rail"])).toEqual(["rail", "subway"]);
  });

  it("maps feature categories", () => {
    expect(collectStopModes(undefined, ["railStation", "busStation"])).toEqual(["rail", "bus"]);
  });

  it("maps feature mode keys after normalization", () => {
    expect(collectStopModes(undefined, undefined, [{ cableCar: null }, { rail: null }])).toEqual([
      "cable_car",
      "rail",
    ]);
  });

  it("combines all three sources without duplicates", () => {
    expect(collectStopModes(["rail"], ["busStation"], [{ tram: null }])).toEqual([
      "rail",
      "bus",
      "tram",
    ]);
  });

  it("defaults to bus when nothing maps", () => {
    expect(collectStopModes()).toEqual(["bus"]);
    expect(collectStopModes([null], ["unknownCategory"])).toEqual(["bus"]);
  });
});

describe("toOccupancyLevel", () => {
  it.each([
    ["empty", "low"],
    ["manySeatsAvailable", "low"],
    ["seatsAvailable", "low"],
    ["fewSeatsAvailable", "medium"],
    ["standingAvailable", "medium"],
    ["standingRoomOnly", "high"],
    ["crushedStandingRoomOnly", "overcrowded"],
    ["full", "overcrowded"],
    ["notAcceptingPassengers", "overcrowded"],
    ["bogus", undefined],
    [null, undefined],
    [undefined, undefined],
  ])("toOccupancyLevel(%j) -> %s", (input, expected) => {
    expect(toOccupancyLevel(input)).toBe(expected);
  });
});

describe("toAlertSeverity", () => {
  it.each([
    ["verySevere", "critical"],
    ["severe", "severe"],
    ["normal", "warning"],
    ["slight", "info"],
    [null, "info"],
    [undefined, "info"],
  ])("toAlertSeverity(%j) -> %s", (input, expected) => {
    expect(toAlertSeverity(input)).toBe(expected);
  });
});

describe("pickLocalizedText", () => {
  it("prefers English over Norwegian", () => {
    expect(
      pickLocalizedText([
        { value: "Norsk", language: "no" },
        { value: "English", language: "en" },
      ]),
    ).toBe("English");
  });

  it("accepts eng as an English variant", () => {
    expect(pickLocalizedText([{ value: "Eng text", language: "eng" }])).toBe("Eng text");
  });

  it("falls back to Norwegian variants when no English is present", () => {
    expect(
      pickLocalizedText([
        { value: "Bokmål", language: "nob" },
        { value: "Deutsch", language: "de" },
      ]),
    ).toBe("Bokmål");
  });

  it("falls back to the first non-empty value when no preferred language matches", () => {
    expect(
      pickLocalizedText([
        { value: "", language: "en" },
        { value: "Italiano", language: "it" },
        { value: "Español", language: "es" },
      ]),
    ).toBe("Italiano");
  });

  it.each([[undefined], [null], [[]]])("returns undefined for %j", (input) => {
    expect(pickLocalizedText(input)).toBeUndefined();
  });
});

describe("nsrTextValue", () => {
  it.each([
    [{ value: "Oslo S" }, "Oslo S"],
    [{ value: "  " }, undefined],
    [{ value: null }, undefined],
    [null, undefined],
    [undefined, undefined],
  ])("nsrTextValue(%j) -> %j", (input, expected) => {
    expect(nsrTextValue(input)).toBe(expected);
  });
});

describe("normalizeColor", () => {
  it.each([
    ["#FF0000", "FF0000"],
    ["00FF00", "00FF00"],
    ["#abc", "abc"],
    ["", undefined],
    ["   ", undefined],
    [null, undefined],
    [undefined, undefined],
  ])("normalizeColor(%j) -> %j", (input, expected) => {
    expect(normalizeColor(input)).toBe(expected);
  });
});

describe("dedupeById", () => {
  it("keeps the first occurrence of each id and preserves order", () => {
    const items = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "a", n: 3 },
      { id: "c", n: 4 },
    ];
    expect(dedupeById(items)).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 4 },
    ]);
  });

  it("returns an empty array unchanged", () => {
    expect(dedupeById([])).toEqual([]);
  });
});

describe("datePartFromIso", () => {
  it.each([
    ["2026-03-10T12:30:00Z", "2026-03-10"],
    ["2026-03-10", "2026-03-10"],
    ["not-a-date", undefined],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
  ])("datePartFromIso(%j) -> %j", (input, expected) => {
    expect(datePartFromIso(input)).toBe(expected);
  });
});

describe("shiftDate", () => {
  it.each([
    ["2026-03-10", 1, "2026-03-11"],
    ["2026-03-10", -1, "2026-03-09"],
    ["2026-03-31", 1, "2026-04-01"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2026-03-10", 0, "2026-03-10"],
  ])("shiftDate(%j, %s) -> %j", (date, days, expected) => {
    expect(shiftDate(date, days)).toBe(expected);
  });
});

describe("calculateDelaySeconds", () => {
  it.each([
    ["2026-03-10T10:00:00Z", "2026-03-10T10:01:00Z", 60],
    ["2026-03-10T10:00:00Z", "2026-03-10T09:59:30Z", -30],
    ["2026-03-10T10:00:00Z", "2026-03-10T10:00:00Z", undefined],
    ["", "2026-03-10T10:00:00Z", undefined],
    ["2026-03-10T10:00:00Z", "", undefined],
    ["garbage", "2026-03-10T10:00:00Z", undefined],
    [null, null, undefined],
  ])("calculateDelaySeconds(%j, %j) -> %s", (aimed, expected, result) => {
    expect(calculateDelaySeconds(aimed, expected)).toBe(result);
  });
});

describe("humanizeNsrEnum", () => {
  it.each([
    ["railStation", "Railstation"],
    ["PARK_AND_RIDE", "Park And Ride"],
    ["onstreetBus", "Onstreetbus"],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
  ])("humanizeNsrEnum(%j) -> %j", (input, expected) => {
    expect(humanizeNsrEnum(input)).toBe(expected);
  });
});

describe("formatTransportModes", () => {
  it("humanizes and joins modes", () => {
    expect(formatTransportModes(["rail", "bus"])).toBe("Rail, Bus");
  });

  it("keeps compound mode tokens humanized", () => {
    expect(formatTransportModes(["cable_car"])).toBe("Cable Car");
  });

  it("returns an empty string for no modes", () => {
    expect(formatTransportModes([])).toBe("");
  });
});

describe("parkingKindFromVehicleTypes", () => {
  it.each<[string[], string | undefined, string]>([
    [[], "PARK_AND_RIDE", "park_and_ride"],
    [[], "TRAIN_STATION_PARKING", "park_and_ride"],
    [["pedal_cycle"], undefined, "bike_parking"],
    [["bicycle"], undefined, "bike_parking"],
    [["car"], undefined, "park_and_ride"],
    [["passenger_car"], undefined, "park_and_ride"],
    [["motor_vehicle"], undefined, "park_and_ride"],
    [["something_else"], undefined, "parking"],
    [[], undefined, "other"],
  ])("parkingKindFromVehicleTypes(%j, %j) -> %s", (vehicleTypes, parkingType, expected) => {
    expect(parkingKindFromVehicleTypes(vehicleTypes, parkingType)).toBe(expected);
  });

  it("prefers the park-and-ride parking type over bike vehicle types", () => {
    expect(parkingKindFromVehicleTypes(["pedal_cycle"], "PARK_AND_RIDE")).toBe("park_and_ride");
  });
});

describe("ensureClosedRing", () => {
  it("closes an open ring by repeating the first point", () => {
    expect(
      ensureClosedRing([
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]);
  });

  it("leaves an already-closed ring untouched", () => {
    const ring: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 0],
    ];
    expect(ensureClosedRing(ring)).toEqual(ring);
  });

  it("returns an empty array unchanged", () => {
    expect(ensureClosedRing([])).toEqual([]);
  });
});

describe("nsrCoordinatesFromPosList", () => {
  it("parses a lat/lng pos list into closed [lng, lat] coordinates", () => {
    expect(nsrCoordinatesFromPosList([0, 0, 0, 1, 1, 1])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]);
  });

  it("keeps an already-closed pos list closed", () => {
    expect(nsrCoordinatesFromPosList([0, 0, 0, 1, 1, 1, 0, 0])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]);
  });

  it.each([
    [null],
    [undefined],
    [[0, 0, 0, 1]],
    [[0, 0, 0, 1, 1]],
    [[0, 0, 0, 1, Number.NaN, 1]],
  ])("rejects invalid pos list %j", (input) => {
    expect(nsrCoordinatesFromPosList(input)).toBeNull();
  });
});

describe("nsrRefValue", () => {
  it.each([
    [{ ref: "NSR:TariffZone:1" }, "NSR:TariffZone:1"],
    [{ value: { ref: "NSR:TariffZone:2" } }, "NSR:TariffZone:2"],
    [{ ref: "  " }, undefined],
    [{}, undefined],
    [null, undefined],
    [undefined, undefined],
  ])("nsrRefValue(%j) -> %j", (input, expected) => {
    expect(nsrRefValue(input)).toBe(expected);
  });

  it("prefers the top-level ref over the nested value ref", () => {
    expect(nsrRefValue({ ref: "top", value: { ref: "nested" } })).toBe("top");
  });
});

describe("nsrPrivateCodeValue", () => {
  it.each([
    [{ value: "PC1" }, "PC1"],
    [{ value: "  " }, undefined],
    [{ value: null }, undefined],
    [null, undefined],
    [undefined, undefined],
  ])("nsrPrivateCodeValue(%j) -> %j", (input, expected) => {
    expect(nsrPrivateCodeValue(input)).toBe(expected);
  });
});

describe("normalizeLine", () => {
  it("maps a fully populated line", () => {
    expect(
      normalizeLine({
        id: "RUT:Line:5",
        publicCode: "5",
        name: "Vestli",
        transportMode: "metro",
        presentation: { colour: "#EC700C", textColour: "#FFFFFF" },
        operator: { id: "RUT:Operator:1", name: "Ruter" },
        authority: { id: "RUT:Authority:1", name: "Ruter AS" },
      }),
    ).toEqual({
      id: "entur:RUT:Line:5",
      shortName: "5",
      longName: "Vestli",
      mode: "subway",
      color: "EC700C",
      textColor: "FFFFFF",
      operatorName: "Ruter",
    });
  });

  it("falls back to authority name when operator is missing", () => {
    const line = normalizeLine({
      id: "RUT:Line:5",
      name: "Line name",
      authority: { id: "a", name: "Authority" },
    });
    expect(line?.operatorName).toBe("Authority");
  });

  it("uses name as shortName and publicCode as longName fallbacks", () => {
    const line = normalizeLine({ id: "RUT:Line:5", name: "Only Name" });
    expect(line?.shortName).toBe("Only Name");
    expect(line?.longName).toBe("Only Name");
  });

  it.each([[null], [undefined], [{ id: "" }]])("returns null for %j", (input) => {
    expect(normalizeLine(input)).toBeNull();
  });
});

describe("normalizeStopPlace", () => {
  it("maps a valid stop place with the entur prefix and identity", () => {
    expect(
      normalizeStopPlace({
        id: "NSR:StopPlace:337",
        name: "Oslo S",
        latitude: 59.911,
        longitude: 10.75,
        transportMode: ["rail", "metro"],
      }),
    ).toEqual({
      id: "entur:NSR:StopPlace:337",
      primaryScheme: "nsr",
      ids: { entur: "NSR:StopPlace:337", nsr: "StopPlace:337" },
      name: "Oslo S",
      lat: 59.911,
      lng: 10.75,
      modes: ["rail", "subway"],
      provider: "entur",
    });
  });

  it.each([
    [null],
    [undefined],
    [{ id: "", name: "x", latitude: 1, longitude: 2 }],
    [{ id: "NSR:StopPlace:1", name: "", latitude: 1, longitude: 2 }],
    [{ id: "NSR:StopPlace:1", name: "x", longitude: 2 }],
    [{ id: "NSR:StopPlace:1", name: "x", latitude: 1 }],
  ])("returns null for invalid stop place %j", (input) => {
    expect(normalizeStopPlace(input)).toBeNull();
  });
});
