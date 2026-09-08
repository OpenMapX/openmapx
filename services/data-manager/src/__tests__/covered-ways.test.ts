import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCoveredWayIds,
  parseConditionsWayIds,
  parseCoveredWayIds,
  parseProfileWayIds,
} from "../jobs/traffic/covered-ways.js";
import { probeHttp } from "../jobs/transitous/motis-probe.js";

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

describe("parseProfileWayIds", () => {
  it("collects way ids, collapsing directions", () => {
    const json = JSON.stringify([
      { way_id: "100118219", dir: "f", free_flow_kph: 100, constrained_kph: 90, hourly: [] },
      { way_id: "100118219", dir: "b", free_flow_kph: 100, constrained_kph: 90, hourly: [] },
      { way_id: "1021132485", dir: "f", free_flow_kph: 120, constrained_kph: 110, hourly: [] },
    ]);
    expect(parseProfileWayIds(json)).toEqual(new Set([100118219, 1021132485]));
  });

  it("skips entries whose way_id is not an integer", () => {
    const json = JSON.stringify([
      { way_id: "not-a-number", dir: "f" },
      { way_id: "", dir: "f" },
      { way_id: "42", dir: "f" },
    ]);
    expect(parseProfileWayIds(json)).toEqual(new Set([42]));
  });

  it("returns an empty set for an empty feed", () => {
    expect(parseProfileWayIds("[]")).toEqual(new Set());
  });

  it("returns an empty set rather than throwing on malformed JSON", () => {
    expect(parseProfileWayIds("{not json")).toEqual(new Set());
  });
});

describe("parseConditionsWayIds", () => {
  it("collects way ids from every segment span", () => {
    const json = JSON.stringify({
      conditions: [
        {
          id: "a",
          segments: [
            { way_id: 10, dir: "f" },
            { way_id: 11, dir: "f" },
          ],
        },
        { id: "b", segments: [{ way_id: 10, dir: "b" }] },
      ],
    });
    expect(parseConditionsWayIds(json)).toEqual(new Set([10, 11]));
  });

  it("tolerates a malformed body", () => {
    expect(parseConditionsWayIds("{")).toEqual(new Set());
  });

  it("tolerates a condition without segments and a non-integer way id", () => {
    const json = JSON.stringify({
      conditions: [{ id: "a" }, { id: "b", segments: [{ way_id: "nope" }, { way_id: "42" }] }],
    });
    expect(parseConditionsWayIds(json)).toEqual(new Set([42]));
  });
});

describe("fetchCoveredWayIds", () => {
  const SPEED_CSV = "way_id,dir,current_kph,free_flow_kph,los\n11,f,50,100,heavy\n";
  const PROFILES = JSON.stringify([{ way_id: "22", dir: "f" }]);
  const CONDITIONS = JSON.stringify({
    conditions: [{ id: "a", segments: [{ way_id: 33, dir: "f" }] }],
  });

  const originalProbeGet = probeHttp.get;

  beforeEach(() => {
    // fetchWithTimeout deliberately uses node:http, not undici. Route it at the
    // global fetch this suite stubs, the way the motis probe suites do.
    probeHttp.get = (url) => fetch(url);
  });

  afterEach(() => {
    probeHttp.get = originalProbeGet;
    vi.unstubAllGlobals();
  });

  const ok = (body: string) => async () => new Response(body, { status: 200 });
  // Defaults to an empty conditions feed so each case only states the half it exercises.
  const stub = (
    speed: () => Promise<Response>,
    profiles: () => Promise<Response>,
    conditions: () => Promise<Response> = ok(JSON.stringify({ conditions: [] })),
  ) => {
    vi.stubGlobal("fetch", (url: string) => {
      const path = String(url);
      if (path.endsWith("/segments/speed.csv")) return speed();
      if (path.endsWith("/segments/conditions.json")) return conditions();
      return profiles();
    });
  };

  it("returns the union of live-speed and profile ways", async () => {
    stub(ok(SPEED_CSV), ok(PROFILES));
    expect(await fetchCoveredWayIds("http://oc")).toEqual(new Set([11, 22]));
  });

  it("de-duplicates a way present in both feeds", async () => {
    stub(ok(SPEED_CSV), ok(JSON.stringify([{ way_id: "11", dir: "f" }])));
    expect(await fetchCoveredWayIds("http://oc")).toEqual(new Set([11]));
  });

  it("degrades to the live-speed set when the profiles feed responds non-2xx", async () => {
    stub(ok(SPEED_CSV), async () => new Response("nope", { status: 500 }));
    expect(await fetchCoveredWayIds("http://oc")).toEqual(new Set([11]));
  });

  it("degrades to the live-speed set when the profiles fetch throws", async () => {
    stub(ok(SPEED_CSV), async () => {
      throw new Error("request timed out");
    });
    expect(await fetchCoveredWayIds("http://oc")).toEqual(new Set([11]));
  });

  it("still throws when the live-speed feed fails", async () => {
    stub(async () => new Response("nope", { status: 503 }), ok(PROFILES));
    await expect(fetchCoveredWayIds("http://oc")).rejects.toThrow(/speed feed responded 503/);
  });

  it("unions the ways bound conditions sit on so the map covers them too", async () => {
    stub(ok(SPEED_CSV), ok(PROFILES), ok(CONDITIONS));
    expect(await fetchCoveredWayIds("http://oc")).toEqual(new Set([11, 22, 33]));
  });

  it("degrades to the other feeds when the conditions feed responds non-2xx", async () => {
    stub(ok(SPEED_CSV), ok(PROFILES), async () => new Response("nope", { status: 500 }));
    expect(await fetchCoveredWayIds("http://oc")).toEqual(new Set([11, 22]));
  });

  it("degrades to the other feeds when the conditions fetch throws", async () => {
    stub(ok(SPEED_CSV), ok(PROFILES), async () => {
      throw new Error("request timed out");
    });
    expect(await fetchCoveredWayIds("http://oc")).toEqual(new Set([11, 22]));
  });
});
