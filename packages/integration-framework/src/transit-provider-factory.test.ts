import { describe, expect, it } from "vitest";
import { captureTransitContributors } from "./transit-provider-factory";

const a = { sourceId: "a", name: "A" };
const b = { sourceId: "b", name: "B" };
describe("transit acquisition receipt capture", () => {
  it("captures uniform backend records and nested leg/fare data before caching", () => {
    const original = { itineraries: [{ legs: [{ mode: "rail" }], fare: { transfers: [] } }] };
    const out = captureTransitContributors(original, [a]);
    expect(out).toMatchObject({ contributors: [a] });
    expect(out.itineraries[0].legs[0]).toMatchObject({ contributors: [a] });
    expect(out.itineraries[0].fare).toMatchObject({ contributors: [a] });
    expect(original).not.toHaveProperty("contributors");
  });
  it("keeps heterogeneous row snapshots, including unknown and explicit empty", () => {
    const out = captureTransitContributors(
      [{ contributors: [a] }, { contributors: [b] }, {}, { contributors: [] }],
      [a, b],
    );
    expect(out.map((row) => (row as { contributors: unknown }).contributors)).toEqual([
      [a],
      [b],
      [],
      [],
    ]);
  });
});

it("preserves a legacy infrastructure API receipt whose sourceId is a native entity ref", () => {
  const out = captureTransitContributors(
    {
      sourceId: "NSR:StopPlace:337",
      canonicalStop: { id: "entur:337" },
      focusLevel: "parent_stop",
      stopId: "entur:337",
    },
    [a],
  );
  expect(out).toMatchObject({ contributors: [a] });
});
