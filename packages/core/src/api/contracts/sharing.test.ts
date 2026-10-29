import { describe, expect, it } from "vitest";
import { MAX_SAVED_PLACE_CAPTURE_BYTES } from "../../saved-place-contributors";
import {
  MAX_PUBLIC_SHARE_JSON_BYTES,
  MAX_SNAPSHOT_PLACES,
  sharingCreateSchema,
  sharingOperations,
  sharingPublicSchema,
} from "./sharing";

describe("sharing contracts", () => {
  it("owns all five operations and preserves public/session distinctions and creation status", () => {
    expect(Object.keys(sharingOperations)).toHaveLength(5);
    expect(sharingOperations.resolvePublicShare.auth).toBe("public");
    expect(Object.values(sharingOperations).filter((v) => v.auth === "session")).toHaveLength(4);
    expect(sharingOperations.createShare.responses).toHaveProperty("201");
    expect(sharingOperations.createShare.responses).not.toHaveProperty("200");
  });
  it("bounds route coordinates, schedules, list sizes and rejects private response fields", () => {
    const route = {
      waypoints: [
        { lat: 52, lng: 13 },
        { lat: 53, lng: 14 },
      ],
      mode: "walking",
    };
    expect(
      sharingCreateSchema.safeParse({ targetType: "route", route: { ...route, schedules: [null] } })
        .success,
    ).toBe(false);
    expect(
      sharingCreateSchema.safeParse({
        targetType: "route",
        route: {
          ...route,
          schedules: [null, { fixedAt: "2026-10-23T12:00", timeZone: "Europe/Berlin" }],
        },
      }).success,
    ).toBe(true);
    expect(
      sharingCreateSchema.safeParse({
        targetType: "route",
        route: {
          ...route,
          waypoints: [
            { lat: 91, lng: 13 },
            { lat: 53, lng: 14 },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      sharingPublicSchema.safeParse({
        type: "list",
        mode: "live",
        name: "Trip",
        icon: null,
        places: [],
        userId: "owner",
      }).success,
    ).toBe(false);
  });
  it("budgets the maximum saved-place text and captured attribution without truncation", () => {
    // JSON escaping needs at most six bytes per UTF-16 code unit for these bounded strings.
    // Captures are independently bounded by their serialized byte count.
    const perPlace = MAX_SAVED_PLACE_CAPTURE_BYTES + 6 * (500 + 500 + 2000 + 200) + 1024;
    expect(perPlace * MAX_SNAPSHOT_PLACES + 6 * (200 + 50) + 1024).toBeLessThan(
      MAX_PUBLIC_SHARE_JSON_BYTES,
    );
  });
});
