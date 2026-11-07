import { describe, expect, it } from "vitest";
import { platformChanged, selectStopPlatform } from "./platform";

describe("event platform evidence", () => {
  it("uses the requested event and distinguishes source correction from a train moving", () => {
    const stop = {
      platform: "78",
      scheduledPlatform: "78",
      arrivalPlatform: {
        code: "2",
        scheduledCode: "1",
        kind: "realtime" as const,
        sourceId: "siri",
      },
      departurePlatform: { code: "3", kind: "correction" as const, sourceId: "siri" },
    };
    expect(selectStopPlatform(stop, "arrival")).toMatchObject({
      code: "2",
      scheduledCode: "1",
      changed: true,
    });
    expect(selectStopPlatform(stop, "departure")).toMatchObject({
      code: "3",
      scheduledCode: "3",
      changed: false,
    });
  });
  it("preserves legacy platforms, sectors, and missing values", () => {
    expect(
      selectStopPlatform({ platform: "5 A-C", scheduledPlatform: "5" }, "departure"),
    ).toMatchObject({ code: "5 A-C", changed: false });
    expect(selectStopPlatform({}, "arrival")).toMatchObject({ code: undefined, changed: false });
    expect(selectStopPlatform({ platform: "901" }, "arrival")).toMatchObject({
      code: "901",
      changed: false,
    });
  });
});

describe("platformChanged", () => {
  it("reports a move to another platform", () => {
    expect(platformChanged("2", "4")).toBe(true);
    expect(platformChanged("1 A-C", "2 A-C")).toBe(true);
    expect(platformChanged("10", "1")).toBe(true);
  });

  it("doesn't report the platform's sections being added or dropped", () => {
    expect(platformChanged("10", "10 A-B")).toBe(false);
    expect(platformChanged("10 A-B", "10")).toBe(false);
  });

  it("doesn't report a change without both platforms", () => {
    expect(platformChanged(undefined, "4")).toBe(false);
    expect(platformChanged("2", undefined)).toBe(false);
    expect(platformChanged("2", " 2 ")).toBe(false);
  });
});

it("does not notify on case or whitespace-only platform differences", () => {
  expect(platformChanged(" 5 A-C ", "5 a-c")).toBe(false);
});
