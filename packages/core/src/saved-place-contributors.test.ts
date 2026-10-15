import { describe, expect, it } from "vitest";
import {
  captureSavedPlaceContributors,
  MAX_SAVED_PLACE_CAPTURE_BYTES,
  parseSavedPlaceContributors,
  savedPlaceContributors,
  savedPlaceContributorsForPlace,
} from "./saved-place-contributors";

const original = {
  sourceId: "one",
  name: "Original publisher",
  attributionText: "Original required notice",
};
const other = { ...original, attributionText: "Different terms, same identity" };

describe("saved field captures", () => {
  it("captures the exact field winner and coordinates without hidden enrichment", () => {
    const source = {
      contributors: [other],
      fieldContributors: { name: [original], address: [], coordinates: [other], phone: [original] },
    };
    const captured = captureSavedPlaceContributors(source);
    expect(captured).toEqual({ name: [original], address: [], lat: [other], lng: [other] });
    expect(savedPlaceContributors(captured, ["name", "address"])).toEqual([original]);
    original.name = "Changed catalogue";
    expect(captured?.name?.[0].name).toBe("Original publisher");
    original.name = "Original publisher";
  });

  it("preserves unknown and explicit empty without any catalogue reconstruction", () => {
    expect(captureSavedPlaceContributors({})).toBeUndefined();
    expect(parseSavedPlaceContributors(null)).toBeUndefined();
    expect(captureSavedPlaceContributors({ contributors: [] })).toEqual({
      name: [],
      address: [],
      lat: [],
      lng: [],
    });
    expect(captureSavedPlaceContributors({ fieldContributors: { name: [] } })).toEqual({
      name: [],
    });
    expect(savedPlaceContributorsForPlace(undefined)).toEqual({});
    expect(savedPlaceContributorsForPlace({ name: [], lat: [original], lng: [other] })).toEqual({
      fieldContributors: {
        name: [],
        coordinates: [original, other],
        "coordinates.1": [original],
        "coordinates.0": [other],
      },
    });
  });

  it.each([
    { lat: [original] },
    { lng: [] },
    { lat: [original], lng: [other] },
    { name: [], lat: [], lng: [] },
  ])(
    "retains exact partial component ownership across saved selection and saving again: %j",
    (fields) => {
      expect(captureSavedPlaceContributors(savedPlaceContributorsForPlace(fields))).toEqual(fields);
    },
  );

  it.each([{ override: [] }, { override: [other] }])(
    "keeps canonical parent ownership for the untouched axis beside child override %j",
    ({ override }) => {
      expect(
        captureSavedPlaceContributors({
          fieldContributors: { coordinates: [original], "coordinates.0": override },
        }),
      ).toEqual({ lat: [original], lng: override });
    },
  );

  it("reconstructs a partial saved point with only known children so unknown axes cannot inherit", () => {
    const saved = { lat: [original], name: [] };
    const selected = savedPlaceContributorsForPlace(saved);
    expect(selected).toEqual({ fieldContributors: { name: [], "coordinates.1": [original] } });
    expect(captureSavedPlaceContributors(selected)).toEqual(saved);
  });

  it("clones while preserving same-id distinct snapshots and rejects malformed or unbounded captures", () => {
    const fields = { name: [original, other], address: [] };
    expect(parseSavedPlaceContributors(JSON.stringify(fields))).toEqual(fields);
    expect(parseSavedPlaceContributors(fields)?.name?.[0]).not.toBe(original);
    for (const input of [
      { phone: [] },
      { name: [{}] },
      { name: "[]" },
      { name: Array(33).fill(original) },
      { name: [{ ...original, notes: "x".repeat(MAX_SAVED_PLACE_CAPTURE_BYTES) }] },
    ]) {
      expect(parseSavedPlaceContributors(input)).toBeUndefined();
    }
  });
});
