import { readFileSync } from "node:fs";
import { createMotisInstance } from "@openmapx/mobility-core/motis-client";
import { describe, expect, it } from "vitest";
import fixture from "../../transit-motis/__tests__/fixtures/re1-26839-transitous-trip.json";
import { motisPlaceToJourneyStop } from "../../transit-motis/adapter";
import { matchJourneyPlatforms } from "../match";
import { parseSiriEt } from "../siri-et-stream";

const xml = readFileSync(new URL("./fixtures/rhein-ruhr-re1.siri.xml", import.meta.url), "utf8");
const now = Date.parse("2026-11-06T21:19:00Z");
function stream(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 91) controller.enqueue(bytes.slice(i, i + 91));
      controller.close();
    },
  });
}
const leg = fixture.legs[0];
const instance = createMotisInstance({
  baseUrl: "http://motis.test",
  prefix: "mo:",
  provider: "mo",
});
const journey = {
  id: "mo:20261106_21:51_de-DELFI_3469151921",
  provider: "mo",
  name: "RE1",
  identity: {
    serviceDate: "2026-11-06",
    trainNumber: "26839",
    lineName: "RE1",
    routeId: leg.routeId,
    feedTag: "de-DELFI",
  },
  stops: [leg.from, ...leg.intermediateStops, leg.to].map((p) =>
    motisPlaceToJourneyStop(instance, p),
  ),
};

describe("streamed SIRI passenger assignments", () => {
  it("matches the full real train and retains source record time rather than fetch time", async () => {
    const feed = await parseSiriEt(stream(xml), now);
    expect(feed.journeys).toHaveLength(1);
    const updates = matchJourneyPlatforms(journey, feed.journeys, now);
    expect(updates.slice(0, 9).map((s) => s.departurePlatform?.code)).toEqual([
      "2",
      "2",
      "2",
      "3",
      "1",
      "3",
      "3",
      "3",
      "5 A-C",
    ]);
    expect(updates[7].departurePlatform).toMatchObject({
      kind: "correction",
      recordedAt: "2026-11-06T18:30:58.165Z",
    });
    expect(updates[26].arrivalPlatform?.code).toBe("8");
  });
  it.each([
    "wrong-date",
    "wrong-line",
    "shifted-event",
    "wrong-stop",
    "incomplete",
    "duplicate",
    "extra",
    "cancelled",
  ])("rejects %s rather than guessing a platform", async (reason) => {
    const feed = await parseSiriEt(stream(xml), now);
    const record = feed.journeys[0];
    if (reason === "wrong-date") record.serviceDate = "2026-11-07";
    if (reason === "wrong-line") record.lineName = "RE9";
    if (reason === "shifted-event") record.calls[0].ad = (record.calls[0].ad ?? 0) + 60;
    if (reason === "wrong-stop") record.calls[0].root = "de:05334:1646";
    if (reason === "incomplete") record.complete = false;
    if (reason === "duplicate") feed.journeys.push(structuredClone(record));
    if (reason === "extra") record.calls[0].extra = true;
    if (reason === "cancelled") record.cancelled = true;
    expect(matchJourneyPlatforms(journey, feed.journeys, now)).toEqual([]);
  });
  it.each([
    xml.replace("<Siri ", "<!DOCTYPE Siri [<!ENTITY bad 'x'>]><Siri "),
    xml.replace("http://www.siri.org.uk/siri", "https://wrong.invalid"),
    xml.replace(
      "<EstimatedTimetableDelivery>",
      "<EstimatedTimetableDelivery><Status>false</Status>",
    ),
    xml.slice(0, -8),
    xml.replace("2026-11-06T21:19:00Z", "2026-11-06T22:19:00Z"),
  ])("rejects unsafe or invalid deliveries", async (value) => {
    await expect(parseSiriEt(stream(value), now)).rejects.toThrow();
  });
  it("does not overwrite a known realtime MOTIS platform with old assignments", async () => {
    const feed = await parseSiriEt(stream(xml), now);
    const current = structuredClone(journey);
    current.stops[0].platform = "9";
    current.stops[0].scheduledPlatform = "2";
    expect(matchJourneyPlatforms(current, feed.journeys, now)[0].departurePlatform).toBeUndefined();
  });
});

it("separates fresh platform-only realtime changes from corrections and preserves sectors", async () => {
  const feed = await parseSiriEt(stream(xml), now);
  const record = feed.journeys[0];
  record.recordedAt = new Date(now - 60_000).toISOString();
  record.calls[0].ed = record.calls[0].ad;
  record.calls[0].dp = "4 A-C";
  const current = structuredClone(journey);
  current.stops[0].platform = "2";
  current.stops[0].scheduledPlatform = "2";
  expect(matchJourneyPlatforms(current, feed.journeys, now)[0].departurePlatform).toMatchObject({
    code: "4 A-C",
    scheduledCode: "2",
    kind: "realtime",
  });
  current.stops[0].platform = "9";
  expect(matchJourneyPlatforms(current, feed.journeys, now)[0].departurePlatform).toBeUndefined();
});
it("matches repeated stations by complete ordered event occurrence, rejecting counter direction", async () => {
  const feed = await parseSiriEt(stream(xml), now);
  const loop = structuredClone(journey);
  loop.stops[2].stopId = loop.stops[0].stopId;
  feed.journeys[0].calls[2].root = feed.journeys[0].calls[0].root;
  expect(matchJourneyPlatforms(loop, feed.journeys, now)).toHaveLength(27);
  feed.journeys[0].calls.reverse();
  expect(matchJourneyPlatforms(loop, feed.journeys, now)).toEqual([]);
});
it("requires a MOTIS timestamp for every supplied aimed event and rejects neighboring trains", async () => {
  const feed = await parseSiriEt(stream(xml), now);
  const current = structuredClone(journey);
  current.stops[1].scheduledArrival = undefined;
  expect(matchJourneyPlatforms(current, feed.journeys, now)).toEqual([]);
  feed.journeys[0].trainNumber = "26841";
  expect(matchJourneyPlatforms(journey, feed.journeys, now)).toEqual([]);
});
it.each([
  xml.replace(
    "<ns0:TrainNumberRef>26839</ns0:TrainNumberRef>",
    "<ns0:TrainNumberRef>26839</ns0:TrainNumberRef><ns0:TrainNumberRef>26841</ns0:TrainNumberRef>",
  ),
  xml.replace("<ns0:TrainNumberRef>26839</ns0:TrainNumberRef>", ""),
])("drops records without one unambiguous train number", async (value) => {
  expect((await parseSiriEt(stream(value), now)).journeys).toEqual([]);
});
it("reads CDATA passenger fields and rejects excessive nesting", async () => {
  const cdata = xml.replace(
    "<ns0:DeparturePlatformName>2</ns0:DeparturePlatformName>",
    "<ns0:DeparturePlatformName><![CDATA[2]]></ns0:DeparturePlatformName>",
  );
  expect((await parseSiriEt(stream(cdata), now)).journeys[0].calls[0].dp).toBe("2");
  await expect(
    parseSiriEt(
      stream(xml.replace("<ServiceDelivery>", `<ServiceDelivery>${"<Nested>".repeat(40)}`)),
      now,
    ),
  ).rejects.toThrow();
});

it("drops only the invalid journey when an event timestamp is malformed", async () => {
  const invalid = xml
    .slice(
      xml.indexOf("<ns0:EstimatedVehicleJourney"),
      xml.indexOf("</ns0:EstimatedVehicleJourney>") + "</ns0:EstimatedVehicleJourney>".length,
    )
    .replace("2026-11-06T20:51:00Z", "not-a-time");
  const mixed = xml.replace(
    "</EstimatedJourneyVersionFrame>",
    `${invalid}</EstimatedJourneyVersionFrame>`,
  );
  expect((await parseSiriEt(stream(mixed), now)).journeys).toHaveLength(1);
});
it("drops records with overlong source timestamps and extra journeys", async () => {
  const overlong = xml.replace(
    "2026-11-06T18:30:58.165Z",
    `2026-11-06T18:30:58.${"1".repeat(70)}Z`,
  );
  expect((await parseSiriEt(stream(overlong), now)).journeys).toHaveLength(0);
  const extra = xml.replace(
    "<ns0:IsCompleteStopSequence>",
    "<ns0:ExtraJourney>1</ns0:ExtraJourney><ns0:IsCompleteStopSequence>",
  );
  const feed = await parseSiriEt(stream(extra), now);
  expect(matchJourneyPlatforms(journey, feed.journeys, now)).toEqual([]);
});
it("keeps sector refinement a schedule assignment", async () => {
  const feed = await parseSiriEt(stream(xml), now);
  const current = structuredClone(journey);
  current.stops[8].platform = "5";
  current.stops[8].scheduledPlatform = "5";
  expect(matchJourneyPlatforms(current, feed.journeys, now)[8].departurePlatform?.kind).toBe(
    "schedule",
  );
});
