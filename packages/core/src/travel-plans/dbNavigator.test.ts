import { describe, expect, it } from "vitest";
import { classifySharedText } from "../navigation/nativeIntake";
import { dbNavigatorExamples } from "./__fixtures__/dbNavigator";
import { parseSharedTravelPlan } from "./index";

const config = { webOrigin: "https://openmapx.com", scheme: "openmapx" };
const plan = (text: string) => {
  const result = parseSharedTravelPlan(text);
  if (result.kind !== "travel-plan") throw new Error(JSON.stringify(result));
  return result.plan;
};
describe("DB Navigator share adapter", () => {
  it.each(dbNavigatorExamples)("parses the complete supplied connection", (text) => {
    const parsed = plan(text);
    expect(parsed.sourceId).toBe("db-navigator");
    expect(classifySharedText(text, config).kind).toBe("travel-plan");
    expect(parsed.legs[0].departure).toMatch(/^2026-11-0[67]T/);
    expect(parsed.legs.at(-1)?.to).toBe(parsed.destination);
    expect(JSON.stringify(parsed)).not.toContain("vbid");
  });
  it("advances dates across night trains and the next transfer", () => {
    expect(plan(dbNavigatorExamples[2]).legs[1].arrival).toBe("2026-11-07T06:04");
    expect(plan(dbNavigatorExamples[3]).legs[1]).toMatchObject({
      departure: "2026-11-08T07:15",
      arrival: "2026-11-08T08:07",
      trainNumber: "26804",
    });
  });
  it("allows a header in EXTRA_SUBJECT to be absent, CRLF and repeated headsigns", () => {
    const text = dbNavigatorExamples[3].split("\n").slice(1).join("\r\n");
    expect(plan(text).origin).toBe("Berlin Hbf");
    expect(
      plan(dbNavigatorExamples[2].replace("Nach Berlin Südkreuz", "Nach Siegen Hbf")).legs,
    ).toHaveLength(2);
  });
  it.each([
    (s: string) => s.replace("06.11.2026", "31.02.2026"),
    (s: string) => s.replace("Fr.", "Mo."),
    (s: string) => s.replace("21:18", "25:18"),
    (s: string) => `${s}\nICE 999\nNach Hamburg Hbf\nAb 23:00 Köln Hbf`,
    (s: string) => s.replace("An 22:11 Köln Hbf", "An 22:11 Bonn Hbf"),
    (s: string) => s.replace("21:18", "22:11"),
    (s: string) => `${s}\n${"x".repeat(4096)}`,
  ])("rejects invalid or incomplete recognized plans without map-search fallback", (change) => {
    expect(parseSharedTravelPlan(change(dbNavigatorExamples[0])).kind).toBe("invalid-travel-plan");
    expect(classifySharedText(change(dbNavigatorExamples[0]), config).kind).not.toBe("map");
  });
  it("requires full text for a DB URL and leaves ordinary text alone", () => {
    expect(parseSharedTravelPlan("https://www.bahn.de/buchung/start?vbid=abc")).toMatchObject({
      kind: "invalid-travel-plan",
      reason: "missing-text",
    });
    expect(parseSharedTravelPlan("Meeting\nAb 10 Uhr im Bahnhof").kind).toBe("unrecognized");
    expect(classifySharedText("Meeting\nAb 10 Uhr im Bahnhof", config).kind).toBe("map");
  });
});

it("does not mistake a public line without an operational number for a train number", () => {
  for (const label of ["S 13", "RE 9", "Bus 63"]) {
    expect(parseSharedTravelPlan(dbNavigatorExamples[0].replace("RE9 (10935)", label)).kind).toBe(
      "invalid-travel-plan",
    );
  }
});
