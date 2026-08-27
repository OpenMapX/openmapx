import {
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  negotiateMobileProtocol,
} from "@openmapx/core/navigation";
import { describe, expect, it } from "vitest";
import { browserEngineAllowed } from "./nativeSnapshotReducer";

interface Side {
  min: number;
  max: number;
}

const CURRENT: Side = { min: MOBILE_PROTOCOL_MIN, max: MOBILE_PROTOCOL_MAX };
const PREVIOUS_ONLY: Side = {
  min: MOBILE_PROTOCOL_MIN - 1,
  max: MOBILE_PROTOCOL_MIN - 1,
};
const FUTURE_ONLY: Side = {
  min: MOBILE_PROTOCOL_MAX + 1,
  max: MOBILE_PROTOCOL_MAX + 1,
};

describe("mobile runtime compatibility", () => {
  it("negotiates the current protocol", () => {
    expect(negotiateMobileProtocol(CURRENT, CURRENT)).toBe(MOBILE_PROTOCOL_MAX);
  });

  it.each([PREVIOUS_ONLY, FUTURE_ONLY])("rejects a non-overlapping range", (other) => {
    expect(negotiateMobileProtocol(CURRENT, other)).toBeNull();
  });

  it("never turns protocol incompatibility into browser navigation authority", () => {
    expect(browserEngineAllowed("error")).toBe(false);
    expect(browserEngineAllowed("negotiating")).toBe(false);
  });

  it("gives browser navigation authority only to an ordinary browser", () => {
    expect(browserEngineAllowed("browser")).toBe(true);
    expect(browserEngineAllowed("native")).toBe(false);
  });
});
