import { cellToParent, latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import { h3CellFromBigint, h3CellToBigint } from "../../src/jobs/overture/h3.js";

describe("H3 cells as bigint", () => {
  it("round-trips cells of every resolution exactly", () => {
    const finest = latLngToCell(50.7753, 6.0839, 15);
    for (let resolution = 0; resolution <= 15; resolution++) {
      const cell = cellToParent(finest, resolution);
      expect(h3CellFromBigint(h3CellToBigint(cell))).toBe(cell);
    }
    // A Number would round the low bits of a fine cell away.
    const exact = h3CellToBigint(finest);
    expect(String(Number(exact))).not.toBe(exact);
  });

  it("matches the value DuckDB's h3_latlng_to_cell casts to bigint", () => {
    expect(h3CellToBigint("881f1d4895fffff")).toBe("613036919439228927");
    expect(h3CellFromBigint("613036919439228927")).toBe("881f1d4895fffff");
  });

  it("keeps the numeric order of cells of one resolution", () => {
    const cells = [
      latLngToCell(52.52, 13.405, 8),
      latLngToCell(50.7753, 6.0839, 8),
      latLngToCell(-33.86, 151.2, 8),
      latLngToCell(35.7, 139.7, 8),
    ];
    const byText = [...cells].sort();
    const byValue = [...cells].sort((a, b) => {
      const difference = BigInt(h3CellToBigint(a)) - BigInt(h3CellToBigint(b));
      return difference < 0n ? -1 : difference > 0n ? 1 : 0;
    });
    expect(byValue).toEqual(byText);
  });

  it("refuses values that are no cell", () => {
    expect(() => h3CellToBigint("not-a-cell")).toThrow(/Invalid H3 cell/);
    expect(() => h3CellToBigint("8000000000000000")).toThrow(/reserved bit/);
    expect(() => h3CellFromBigint("-1")).toThrow(/Invalid H3 cell value/);
  });
});
