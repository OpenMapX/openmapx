import { describe, expect, it } from "vitest";
import { isLiveNavigationStatus } from "../liveStatus";

describe("isLiveNavigationStatus", () => {
  it("is false before navigation starts", () => {
    expect(isLiveNavigationStatus("idle")).toBe(false);
  });

  it("is true while actively navigating", () => {
    expect(isLiveNavigationStatus("navigating")).toBe(true);
  });

  it("is true while recovering from an off-route reroute", () => {
    expect(isLiveNavigationStatus("rerouting")).toBe(true);
  });

  it("is false once arrived, even though the session is still on screen", () => {
    expect(isLiveNavigationStatus("arrived")).toBe(false);
  });
});
