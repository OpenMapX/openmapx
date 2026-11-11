import type { TransitProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STATIONS = {
  station: [
    {
      id: "BE.NMBS.008814001",
      name: "Brussels-South",
      locationX: "4.336531",
      locationY: "50.835707",
    },
    { id: "BE.NMBS.008821006", name: "Leuven", locationX: "4.71566", locationY: "50.88143" },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/stations")) return Response.json(STATIONS);
    return Response.json({ connection: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("brusselsWallClock", () => {
  it.each([
    ["winter", "2026-01-15T07:30:00Z", "2026-01-15", "08:30:00"],
    ["summer", "2026-07-01T06:30:00Z", "2026-07-01", "08:30:00"],
    ["the last minute before spring-forward", "2026-03-29T00:59:00Z", "2026-03-29", "01:59:00"],
    ["the first minute after spring-forward", "2026-03-29T01:00:00Z", "2026-03-29", "03:00:00"],
    ["the first pass through fall-back", "2026-10-25T00:30:00Z", "2026-10-25", "02:30:00"],
    ["the second pass through fall-back", "2026-10-25T01:30:00Z", "2026-10-25", "02:30:00"],
    [
      "a UTC evening that is already tomorrow in Brussels",
      "2026-11-10T23:30:00Z",
      "2026-11-11",
      "00:30:00",
    ],
  ])("renders %s on the Brussels clock", async (_case, instant, date, time) => {
    const { brusselsWallClock } = await import("./provider.js");
    expect(brusselsWallClock(new Date(instant))).toEqual({ date, time });
  });

  it("rejects an invalid instant as an input error", async () => {
    const { brusselsWallClock } = await import("./provider.js");
    expect(() => brusselsWallClock(new Date("nope"))).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });
});

describe("iRail planTrip", () => {
  async function planner(): Promise<TransitProvider> {
    const { setup } = await import("./index.js");
    const ctx = createMockIntegrationContext({ id: "transit-irail" });
    setup(ctx);
    const provider = ctx.registered.transit[0];
    if (!provider?.planTrip) throw new Error("iRail planner not registered");
    return provider;
  }

  function connectionRequest(): URL {
    const call = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname.startsWith("/connections"));
    if (!call) throw new Error("no connections request");
    return call;
  }

  const brussels = { lat: 50.8357, lng: 4.3365 };
  const leuven = { lat: 50.8814, lng: 4.7157 };

  it("plans the default all-transit request in Brussels local time", async () => {
    await (await planner()).planTrip?.({
      from: brussels,
      to: leuven,
      modes: ["TRANSIT"],
      departureTime: "2026-07-01T06:30:00Z",
    });
    const url = connectionRequest();
    expect(url.searchParams.get("date")).toBe("010726");
    expect(url.searchParams.get("time")).toBe("0830");
    expect(url.searchParams.get("timeSel")).toBe("departure");
  });

  it("uses the winter offset for an arrival deadline", async () => {
    await (await planner()).planTrip?.({
      from: brussels,
      to: leuven,
      arrivalTime: "2026-12-01T17:05:00Z",
    });
    const url = connectionRequest();
    expect(url.searchParams.get("date")).toBe("011226");
    expect(url.searchParams.get("time")).toBe("1805");
    expect(url.searchParams.get("timeSel")).toBe("arrival");
  });

  it("steps aside for a real mode restriction", async () => {
    const result = await (await planner()).planTrip?.({
      from: brussels,
      to: leuven,
      modes: ["BUS"],
      departureTime: "2026-07-01T06:30:00Z",
    });
    expect(result?.data).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
