import { describe, expect, it } from "vitest";
import { browserEngineAllowed } from "./nativeSnapshotReducer";

describe("mobile runtime compatibility", () => {
  it("never turns protocol incompatibility into browser navigation authority", () => {
    expect(browserEngineAllowed("error")).toBe(false);
    expect(browserEngineAllowed("negotiating")).toBe(false);
  });

  it("gives browser navigation authority only to an ordinary browser", () => {
    expect(browserEngineAllowed("browser")).toBe(true);
    expect(browserEngineAllowed("native")).toBe(false);
  });
});
