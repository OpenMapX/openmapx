import { describe, expect, it } from "vitest";
import { parseBbox } from "../index.js";

describe("parseBbox", () => {
  it("parses a valid bbox", () => {
    expect(parseBbox("-1,51,1,52")).toEqual([-1, 51, 1, 52]);
  });

  it("returns null for missing input", () => {
    expect(parseBbox(undefined)).toBeNull();
  });

  it("rejects a blank segment instead of silently substituting 0", () => {
    expect(parseBbox("1,,3,4")).toBeNull();
  });

  it("rejects non-finite segments", () => {
    expect(parseBbox("1,NaN,3,4")).toBeNull();
    expect(parseBbox("1,2,3")).toBeNull();
  });

  it("rejects out-of-range longitude", () => {
    expect(parseBbox("-181,51,1,52")).toBeNull();
    expect(parseBbox("-1,51,181,52")).toBeNull();
  });

  it("rejects out-of-range latitude", () => {
    expect(parseBbox("-1,-91,1,52")).toBeNull();
    expect(parseBbox("-1,51,1,91")).toBeNull();
  });

  it("rejects an inverted box where south > north", () => {
    expect(parseBbox("-1,52,1,51")).toBeNull();
  });

  it("rejects an inverted box where west > east (antimeridian boxes unsupported)", () => {
    expect(parseBbox("170,10,-170,20")).toBeNull();
  });
});
