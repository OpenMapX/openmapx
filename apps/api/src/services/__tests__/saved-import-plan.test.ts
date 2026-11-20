import { describe, expect, it } from "vitest";
import { planSavedImport, suffixedListName } from "../saved-import-plan.js";

const place = (name: string, lat: number, lng: number) => ({ name, lat, lng });

describe("planSavedImport", () => {
  it("numbers accepted places after the highest existing order", () => {
    const plan = planSavedImport(
      [{ ...place("Kept", 1, 1), sortOrder: 7 }],
      [place("A", 2, 2), place("B", 3, 3)],
    );
    expect(plan.accepted.map(({ place: p, sortOrder }) => [p.name, sortOrder])).toEqual([
      ["A", 8],
      ["B", 9],
    ]);
    expect(plan.skippedDuplicates).toBe(0);
  });

  it("starts at 0 in an empty list", () => {
    expect(planSavedImport([], [place("A", 1, 1)]).accepted[0]?.sortOrder).toBe(0);
  });

  // The exact boundary sits at 0, where a 1e-5 difference has no rounding error.
  it.each([
    ["the same point", [52.52, 13.405], [52.52, 13.405], true],
    ["within 1e-5 in a neighbouring grid cell", [52.52, 13.405], [52.520009, 13.405009], true],
    ["exactly 1e-5 away", [0, 0], [1e-5, 0], true],
    ["just beyond 1e-5", [52.52, 13.405], [52.52 + 1.5e-5, 13.405], false],
  ])("treats a same-name place at %s as duplicate: %s", (_label, kept, imported, duplicate) => {
    const plan = planSavedImport(
      [{ ...place("Cafe", kept[0] ?? 0, kept[1] ?? 0), sortOrder: 0 }],
      [place("Cafe", imported[0] ?? 0, imported[1] ?? 0)],
    );
    expect(plan.skippedDuplicates).toBe(duplicate ? 1 : 0);
    expect(plan.accepted).toHaveLength(duplicate ? 0 : 1);
  });

  it("keeps a differently named place at the same point", () => {
    const plan = planSavedImport(
      [{ ...place("Cafe", 52.52, 13.405), sortOrder: 0 }],
      [place("Bakery", 52.52, 13.405)],
    );
    expect(plan.accepted).toHaveLength(1);
  });

  it("drops a duplicate within the incoming batch and keeps the first", () => {
    const first = { ...place("Cafe", 52.52, 13.405), note: "first" };
    const second = { ...place("Cafe", 52.520001, 13.405), note: "second" };
    const plan = planSavedImport([], [first, second]);
    expect(plan.accepted.map(({ place: p }) => p.note)).toEqual(["first"]);
    expect(plan.skippedDuplicates).toBe(1);
  });
});

describe("suffixedListName", () => {
  it("leaves the first attempt unsuffixed and numbers later ones", () => {
    expect(suffixedListName("Trip", 1)).toBe("Trip");
    expect(suffixedListName("Trip", 3)).toBe("Trip (3)");
  });

  it("keeps a suffixed name within 200 characters", () => {
    const name = suffixedListName("x".repeat(200), 2);
    expect(name).toHaveLength(200);
    expect(name.endsWith(" (2)")).toBe(true);
  });

  it("never cuts a surrogate pair in half", () => {
    const base = `${"x".repeat(195)}😀😀`;
    const name = suffixedListName(base, 2);
    expect(name).toBe(`${"x".repeat(195)} (2)`);
  });
});
