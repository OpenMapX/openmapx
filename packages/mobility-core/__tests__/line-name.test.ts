import { describe, expect, it } from "vitest";
import { splitLineName } from "../src/line-name";

describe("splitLineName", () => {
  it("takes the train number out of the name", () => {
    expect(splitLineName("RE1 (26826)")).toEqual({ name: "RE1", trainNumber: "26826" });
    expect(splitLineName("RB48 (Zug-Nr. 17358)")).toEqual({ name: "RB48", trainNumber: "17358" });
  });

  it("drops the source's operator before a line designation", () => {
    expect(splitLineName("DB S11 (Zug-Nr. 33192)", "DB")).toEqual({
      name: "S11",
      trainNumber: "33192",
    });
    expect(splitLineName("ICE 203", "DB")).toEqual({ name: "ICE 203" });
    expect(splitLineName("DB S11")).toEqual({ name: "DB S11" });
  });

  it("drops a bracket the source cut off", () => {
    expect(splitLineName("RE 1 (RR")).toEqual({ name: "RE 1" });
  });

  it("keeps names without decoration, including brackets that aren't numbers", () => {
    expect(splitLineName("ICE 203")).toEqual({ name: "ICE 203" });
    expect(splitLineName("S6")).toEqual({ name: "S6" });
    expect(splitLineName("Bus 17 (SEV)")).toEqual({ name: "Bus 17 (SEV)" });
    expect(splitLineName("")).toEqual({ name: "" });
  });
});
