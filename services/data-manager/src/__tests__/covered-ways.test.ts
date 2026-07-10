import { describe, expect, it } from "vitest";
import { parseCoveredWayIds } from "../jobs/traffic/covered-ways.js";

describe("parseCoveredWayIds", () => {
  const HEADER = "way_id,dir,current_kph,free_flow_kph,los";

  it("extracts the way_id column, collapsing directions to unique way ids", () => {
    const csv = [
      HEADER,
      "100118219,f,45,59.4,heavy",
      "100118219,b,50,59.4,heavy",
      "1021132485,f,101,75,free_flow",
    ].join("\n");
    expect(parseCoveredWayIds(csv)).toEqual(new Set([100118219, 1021132485]));
  });

  it("ignores the header, blank lines, and a trailing newline", () => {
    const csv = `${HEADER}\n\n100118219,f,45,59.4,heavy\n\n1021132485,f,101,75,free_flow\n`;
    expect(parseCoveredWayIds(csv)).toEqual(new Set([100118219, 1021132485]));
  });

  it("returns an empty set for a header-only feed", () => {
    expect(parseCoveredWayIds(`${HEADER}\n`)).toEqual(new Set());
  });

  it("skips rows whose way_id is not an integer", () => {
    const csv = [HEADER, ",f,45,59.4,heavy", "abc,f,45,59.4,heavy", "42,f,45,59.4,heavy"].join(
      "\n",
    );
    expect(parseCoveredWayIds(csv)).toEqual(new Set([42]));
  });
});
