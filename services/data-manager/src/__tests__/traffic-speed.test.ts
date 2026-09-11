import { describe, expect, it } from "vitest";
import { encodeClosedTrafficSpeed, encodeTrafficSpeed } from "../jobs/traffic/traffic-speed.js";

describe("encodeTrafficSpeed", () => {
  it("encodes 100 kph as overall/speed1 = 50, breakpoint1 = 255", () => {
    const b = encodeTrafficSpeed(100);
    const v = b.readBigUInt64LE(0);
    expect(Number(v & 0x7fn)).toBe(50); // overall (bits 0-6)
    expect(Number((v >> 7n) & 0x7fn)).toBe(50); // speed1  (bits 7-13)
    expect(Number((v >> 28n) & 0xffn)).toBe(255); // breakpoint1 (bits 28-35)
  });

  it("sets breakpoint2 = 255 for a real speed (whole edge is one subsegment)", () => {
    const v = encodeTrafficSpeed(100).readBigUInt64LE(0);
    expect(Number((v >> 36n) & 0xffn)).toBe(255); // breakpoint2 (bits 36-43)
  });

  it("encodes null as the unknown sentinel with breakpoint1=0", () => {
    const v = encodeTrafficSpeed(null).readBigUInt64LE(0);
    expect(Number(v & 0x7fn)).toBe(127);
    expect(Number((v >> 28n) & 0xffn)).toBe(0);
  });

  it.each([0, 0.1, 1, 1.99])("does not encode measured speed %s as a closure", (speed) => {
    const v = encodeTrafficSpeed(speed).readBigUInt64LE(0);
    expect(Number(v & 0x7fn)).toBe(127);
    expect(Number((v >> 28n) & 0xffn)).toBe(0);
  });

  it("clamps overflow speeds to the max real value (126)", () => {
    const v = encodeTrafficSpeed(300).readBigUInt64LE(0);
    expect(Number(v & 0x7fn)).toBe(126); // overall
    expect(Number((v >> 7n) & 0x7fn)).toBe(126); // speed1
  });

  it("treats negative or NaN kph as the unknown sentinel", () => {
    const negative = encodeTrafficSpeed(-5).readBigUInt64LE(0);
    expect(Number(negative & 0x7fn)).toBe(127);
    expect(Number((negative >> 28n) & 0xffn)).toBe(0);

    const nan = encodeTrafficSpeed(Number.NaN).readBigUInt64LE(0);
    expect(Number(nan & 0x7fn)).toBe(127);
    expect(Number((nan >> 28n) & 0xffn)).toBe(0);
  });

  it("returns exactly 8 bytes", () => {
    expect(encodeTrafficSpeed(100).length).toBe(8);
    expect(encodeTrafficSpeed(null).length).toBe(8);
  });
});

describe("encodeClosedTrafficSpeed", () => {
  it("encodes a closed edge as speed 0 with a valid breakpoint (never the unknown sentinel)", () => {
    const v = encodeClosedTrafficSpeed().readBigUInt64LE(0);
    expect(Number(v & 0x7fn)).toBe(0); // overall_encoded_speed
    expect(Number((v >> 7n) & 0x7fn)).toBe(0); // encoded_speed1
    expect(Number((v >> 28n) & 0xffn)).toBe(255); // breakpoint1
    expect(Number((v >> 36n) & 0xffn)).toBe(255); // breakpoint2
  });

  it("leaves every other field zero and returns exactly 8 bytes", () => {
    const buf = encodeClosedTrafficSpeed();
    expect(buf.length).toBe(8);
    const v = buf.readBigUInt64LE(0);
    expect(Number((v >> 14n) & 0x7fn)).toBe(0); // encoded_speed2
    expect(Number((v >> 21n) & 0x7fn)).toBe(0); // encoded_speed3
    expect(Number((v >> 44n) & 0x3fn)).toBe(0); // congestion1
    expect(Number((v >> 50n) & 0x3fn)).toBe(0); // congestion2
    expect(Number((v >> 56n) & 0x3fn)).toBe(0); // congestion3
    expect(Number((v >> 62n) & 0x1n)).toBe(0); // has_incidents
  });

  it("differs from the no-data record so a closure is never mistaken for missing data", () => {
    expect(encodeClosedTrafficSpeed()).not.toEqual(encodeTrafficSpeed(null));
  });
});
