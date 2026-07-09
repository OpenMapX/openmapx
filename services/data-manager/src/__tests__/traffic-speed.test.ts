import { describe, expect, it } from "vitest";
import { encodeTrafficSpeed } from "../jobs/traffic/traffic-speed.js";

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

  it("encodes 0 kph as a valid CLOSED record (overall=0, breakpoint1=255)", () => {
    const v = encodeTrafficSpeed(0).readBigUInt64LE(0);
    expect(Number(v & 0x7fn)).toBe(0);
    expect(Number((v >> 28n) & 0xffn)).toBe(255);
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
