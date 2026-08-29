import { describe, expect, it } from "vitest";
import { QueryValidationError, scalarQueries, scalarQuery } from "../query";

describe("scalarQuery", () => {
  it("returns a present scalar and preserves a missing optional key", () => {
    expect(scalarQuery({ lat: "1" }, "lat")).toBe("1");
    expect(scalarQuery({ lat: "1" }, "lng")).toBeUndefined();
  });

  it("rejects repeated scalar parameters", () => {
    expect(() => scalarQuery({ lat: ["1", "2"] }, "lat")).toThrow(QueryValidationError);
    expect(() => scalarQuery({ lat: ["1", "2"] }, "lat")).toThrow(
      'Query parameter "lat" must appear once',
    );
  });
});

describe("scalarQueries", () => {
  it("returns a string-only record and rejects any repeated key", () => {
    expect(scalarQueries({ lat: "1", missing: undefined })).toEqual({ lat: "1" });
    expect(() => scalarQueries({ lat: "1", lng: ["2", "3"] })).toThrow(
      'Query parameter "lng" must appear once',
    );
  });
});
