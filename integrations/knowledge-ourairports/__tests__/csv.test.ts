import { describe, expect, it } from "vitest";
import { parseCsv, parseOptionalFloat, parseOptionalInt } from "../csv.js";

describe("CSV parser", () => {
  it("parses a simple header + rows", () => {
    const text = ["id,name,lat", "1,Foo,40.5", "2,Bar,-7.3"].join("\n");
    const rows = parseCsv(text);
    expect(rows).toEqual([
      { id: "1", name: "Foo", lat: "40.5" },
      { id: "2", name: "Bar", lat: "-7.3" },
    ]);
  });

  it('handles quoted fields with embedded commas (airport names like "Hartsfield-Jackson Atlanta International, GA")', () => {
    const text = ["id,name", '1,"Hartsfield-Jackson Atlanta International, GA"'].join("\n");
    const rows = parseCsv(text);
    expect(rows[0].name).toBe("Hartsfield-Jackson Atlanta International, GA");
  });

  it("handles doubled quotes inside quoted fields", () => {
    const text = ["id,name", '1,"He said ""hi"" today"'].join("\n");
    const rows = parseCsv(text);
    expect(rows[0].name).toBe('He said "hi" today');
  });

  it("tolerates trailing blank lines", () => {
    const text = "id,name\n1,Foo\n\n";
    const rows = parseCsv(text);
    expect(rows).toEqual([{ id: "1", name: "Foo" }]);
  });

  it("handles CRLF line endings", () => {
    const text = "id,name\r\n1,Foo\r\n2,Bar\r\n";
    const rows = parseCsv(text);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ id: "2", name: "Bar" });
  });

  it("treats empty fields as empty strings (not undefined)", () => {
    const text = "id,iata_code,icao_code\n1,,EDDF";
    const rows = parseCsv(text);
    expect(rows[0]).toEqual({ id: "1", iata_code: "", icao_code: "EDDF" });
  });

  it("parseOptionalInt returns undefined for blanks and non-numeric input", () => {
    expect(parseOptionalInt("")).toBeUndefined();
    expect(parseOptionalInt(undefined)).toBeUndefined();
    expect(parseOptionalInt("abc")).toBeUndefined();
    expect(parseOptionalInt("42")).toBe(42);
    expect(parseOptionalInt("-7")).toBe(-7);
  });

  it("parseOptionalFloat returns undefined for blanks", () => {
    expect(parseOptionalFloat("")).toBeUndefined();
    expect(parseOptionalFloat("121.500")).toBe(121.5);
    expect(parseOptionalFloat("-77.4567")).toBeCloseTo(-77.4567);
  });
});
