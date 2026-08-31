import type { ParkingFacility } from "@openmapx/mobility-core/parking";
import { describe, expect, it, vi } from "vitest";

type MaybePromise<T> = T | Promise<T>;

export interface ParkingEquivalenceContractOptions {
  name: string;
  reference(): MaybePromise<ParkingFacility[]>;
  migrated(): MaybePromise<ParkingFacility[]>;
  fields: readonly (keyof ParkingFacility)[];
  coordinatePrecision?: number;
}

async function loadFacilities(options: ParkingEquivalenceContractOptions) {
  return Promise.all([options.reference(), options.migrated()]);
}

export function stubSuccessfulFetchResponse(url: string, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const requestedUrl = String(input);
      if (requestedUrl === url) return new Response(body, { status: 200 });
      throw new Error(`Unexpected request: ${requestedUrl}`);
    }),
  );
}

export function parkingEquivalenceContract(options: ParkingEquivalenceContractOptions): void {
  describe(`${options.name} parking equivalence contract`, () => {
    it("preserves facility identity, order, and declared fields", async () => {
      const [reference, migrated] = await loadFacilities(options);

      expect(migrated).toHaveLength(reference.length);
      expect(migrated.map((facility) => facility.id)).toEqual(
        reference.map((facility) => facility.id),
      );

      for (let index = 0; index < reference.length; index += 1) {
        const expected = reference[index];
        const actual = migrated[index];
        if (!expected || !actual) throw new Error(`Missing facility at row ${index}`);

        for (const field of options.fields) {
          if (field === "id") {
            continue;
          }
          if (field === "coordinates" && options.coordinatePrecision !== undefined) {
            expect(actual.coordinates[0], `row ${index}: longitude`).toBeCloseTo(
              expected.coordinates[0],
              options.coordinatePrecision,
            );
            expect(actual.coordinates[1], `row ${index}: latitude`).toBeCloseTo(
              expected.coordinates[1],
              options.coordinatePrecision,
            );
          } else {
            expect(actual[field], `row ${index}: ${field}`).toEqual(expected[field]);
          }
        }
      }
    });
  });
}
