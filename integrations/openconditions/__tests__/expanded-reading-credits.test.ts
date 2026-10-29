import { describe, expect, it } from "vitest";
import { recordToBorderCrossing } from "../border/map";
import { recordToCamera } from "../cameras/map";
import { recordToChargingSite } from "../charging/map";
import { type LatestReading, NO_SOURCES, type Rec } from "../features/record";
import { recordToFuelStation } from "../fuel/map";
import { recordToParkingSite } from "../parking/map";
import { recordToRoadWeatherStation } from "../road-weather/map";
import { recordToMessageSign } from "../signs/map";
import border from "./fixtures/features-border.json" with { type: "json" };
import cameras from "./fixtures/features-cameras.json" with { type: "json" };
import charging from "./fixtures/features-charging.json" with { type: "json" };
import fuel from "./fixtures/features-fuel.json" with { type: "json" };
import parking from "./fixtures/features-parking.json" with { type: "json" };
import signs from "./fixtures/features-signs.json" with { type: "json" };
import weather from "./fixtures/features-weather.json" with { type: "json" };

type Wire = { records: Rec[]; latest: Record<string, Rec[]>; offers?: Record<string, Rec[]> };
const sources = { ...NO_SOURCES, mediaHosts: () => ["weathercam.digitraffic.fi", "example.org"] };
const rows = [
  {
    name: "camera",
    fixture: cameras,
    map: (r: Rec, l: LatestReading[]) =>
      recordToCamera(r, l, undefined, sources, new Date("2026-10-08T07:20:00Z")),
  },
  { name: "fuel", fixture: fuel, map: (r: Rec, l: LatestReading[]) => recordToFuelStation(r, l) },
  {
    name: "charging",
    fixture: charging,
    map: (r: Rec, l: LatestReading[]) =>
      recordToChargingSite(r, l, [], undefined, undefined, new Date("2026-10-06T03:10:00Z")),
  },
  {
    name: "parking",
    fixture: parking,
    map: (r: Rec, l: LatestReading[]) =>
      recordToParkingSite(r, l, [], undefined, undefined, new Date("2026-10-05T03:30:00Z")),
  },
  { name: "signs", fixture: signs, map: (r: Rec, l: LatestReading[]) => recordToMessageSign(r, l) },
  {
    name: "weather",
    fixture: weather,
    map: (r: Rec, l: LatestReading[]) =>
      recordToRoadWeatherStation(r, l, undefined, undefined, new Date("2026-10-16T23:00:00Z")),
  },
  {
    name: "border",
    fixture: border,
    map: (r: Rec, l: LatestReading[]) =>
      recordToBorderCrossing(r, l, undefined, undefined, new Date("2026-10-14T23:45:00Z")),
  },
];

describe("expanded reading receipts", () => {
  it.each(rows)(
    "keeps the selected $name observation's capture, independent of feature metadata",
    ({ fixture, map }) => {
      const wire = structuredClone(fixture) as unknown as Wire;
      const record = wire.records[0]!;
      const readings = wire.latest[String(record.id)]!;
      for (const reading of readings)
        reading.provenance = {
          sourceId: "historical-reading",
          attribution: {
            provider: "Captured measurement notice",
            name: "Captured measurement",
            url: "https://example.com/old",
            publisher: { name: "Original publisher" },
          },
          upstream: [{ publisher: "Original upstream", attribution: "Original upstream notice" }],
        };
      const result = map(record, readings as unknown as LatestReading[]);
      expect(result).not.toBeNull();
      const receipts = result!.attributions;
      expect(receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: "historical-reading",
            name: "Captured measurement",
            attributionText: "Captured measurement notice",
          }),
          expect.objectContaining({ attributionText: "Original upstream notice" }),
        ]),
      );
    },
  );
});
