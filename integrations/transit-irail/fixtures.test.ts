import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import connectionsFixture from "./__fixtures__/connections.json";
import liveboardFixture from "./__fixtures__/liveboard.json";
import vehicleFixture from "./__fixtures__/vehicle.json";

const STATIONS = {
  station: [
    {
      id: "BE.NMBS.008821006",
      name: "Antwerp-Central",
      locationX: "4.421101",
      locationY: "51.2172",
    },
    { id: "BE.NMBS.008822004", name: "Mechelen", locationX: "4.482785", locationY: "51.017648" },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
const requests: URL[] = [];

beforeEach(() => {
  vi.resetModules();
  requests.length = 0;
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.startsWith("/stations")) return Response.json(STATIONS);
    if (url.pathname.startsWith("/liveboard")) return Response.json(liveboardFixture);
    if (url.pathname.startsWith("/vehicle")) return Response.json(vehicleFixture);
    if (url.pathname.startsWith("/connections")) return Response.json(connectionsFixture);
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2017-03-15T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("iRail documented responses", () => {
  it("maps a documented liveboard and requests the station's departures", async () => {
    const { getDepartures } = await import("./provider.js");

    const departures = await getDepartures("ir:BE.NMBS.008892007", 120);

    expect(departures).toEqual([
      expect.objectContaining({
        tripId: "BE.NMBS.IC3033",
        route: expect.objectContaining({ shortName: "IC3033", longName: "IC3033" }),
        headsign: "Antwerp-Central",
        scheduledAt: "2017-03-15T11:00:00.000Z",
        platform: "4",
        canceled: false,
      }),
    ]);
    const url = requests.find((request) => request.pathname.startsWith("/liveboard"));
    expect(url?.searchParams.get("id")).toBe("BE.NMBS.008892007");
    expect(url?.searchParams.get("arrdep")).toBe("departure");
  });

  it("maps a documented vehicle journey with station coordinates", async () => {
    const { getVehicleJourney } = await import("./provider.js");

    const journey = await getVehicleJourney("ir:BE.NMBS.IC3033");

    expect(journey).toMatchObject({ id: "ir:BE.NMBS.IC3033", name: "BE.NMBS.IC3033" });
    expect(journey?.stops[0]).toMatchObject({
      stopId: "ir:BE.NMBS.008821006",
      lat: 51.2172,
      lng: 4.421101,
      platform: "4",
    });
    expect(requests.at(-1)?.searchParams.get("id")).toBe("BE.NMBS.IC3033");
  });

  it("maps a documented connection with a transfer", async () => {
    const { planConnections } = await import("./provider.js");

    const plan = await planConnections(51.2172, 4.4211, 51.0176, 4.4828, "2017-06-18", "11:00");

    const itinerary = plan?.itineraries[0];
    expect(itinerary).toMatchObject({ duration: 3240, transfers: 1 });
    expect(itinerary?.legs.filter((leg) => leg.mode === "rail")).toHaveLength(2);
    const url = requests.find((request) => request.pathname.startsWith("/connections"));
    expect(url?.searchParams.get("from")).toBe("BE.NMBS.008821006");
    expect(url?.searchParams.get("to")).toBe("BE.NMBS.008822004");
    expect(url?.searchParams.get("date")).toBe("180617");
    expect(url?.searchParams.get("time")).toBe("1100");
  });

  it("reports a 200 without liveboard fields as an invalid payload, not as no departures", async () => {
    fetchMock.mockImplementation(async () => Response.json({ version: "1.1", timestamp: 1 }));
    const { getDepartures } = await import("./provider.js");

    await expect(getDepartures("ir:BE.NMBS.008892007", 60)).rejects.toMatchObject({
      code: "invalid_payload",
    });
  });

  it("treats a 404 for a caller's station id as bad input and a 404 on the station list as a failure", async () => {
    const { classifyProviderFailure } = await import("@openmapx/integration-framework");
    fetchMock.mockImplementation(async () => new Response("not found", { status: 404 }));
    const { getDepartures, getStops } = await import("./provider.js");

    const unknown = await getDepartures("ir:BE.NMBS.000000000", 60).catch(
      (error: unknown) => error,
    );
    expect(classifyProviderFailure(unknown)).toBe("input");

    const stations = await getStops(50.8, 4.3, 500).catch((error: unknown) => error);
    expect(classifyProviderFailure(stations)).toBe("connection");
  });

  it("keeps valid departures and drops one without a time", async () => {
    const [entry] = liveboardFixture.departures.departure;
    fetchMock.mockImplementation(async () =>
      Response.json({
        departures: {
          number: "2",
          departure: [
            { ...entry, time: null },
            { ...entry, time: "1489575660" },
          ],
        },
      }),
    );
    const { getDepartures } = await import("./provider.js");

    const departures = await getDepartures("ir:BE.NMBS.008892007", 120);

    expect(departures.map((d) => d.scheduledAt)).toEqual(["2017-03-15T11:01:00.000Z"]);
  });
});
