import { describe, expect, it } from "vitest";
import { emphasizeRoadNames } from "./emphasizeRoadNames";

describe("emphasizeRoadNames", () => {
  it("prefers a name and ref joined the way the instruction writes them", () => {
    expect(
      emphasizeRoadNames("Turn right onto Alexanderstraße/B 1. Continue on B 1.", [
        "Alexanderstraße",
        "B 1",
      ]),
    ).toEqual([
      { text: "Turn right onto ", road: false },
      { text: "Alexanderstraße/B 1", road: true },
      { text: ". Continue on ", road: false },
      { text: "B 1", road: true },
      { text: ".", road: false },
    ]);
  });

  it("leaves an instruction that names none of the roads as it is", () => {
    expect(emphasizeRoadNames("Turn left toward Tiergarten.", ["Spandauer Straße"])).toEqual([
      { text: "Turn left toward Tiergarten.", road: false },
    ]);
    expect(emphasizeRoadNames("Drive northeast.", undefined)).toEqual([
      { text: "Drive northeast.", road: false },
    ]);
  });
});
