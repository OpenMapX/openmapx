import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { planInstant, setup } from "../index";

const orchestrator = vi.hoisted(() => ({ planTrip: vi.fn() }));
vi.mock("../orchestrator", async (original) => ({
  ...(await original<object>()),
  createTransitOrchestrator: () => orchestrator,
}));

const NOW = new Date("2026-11-10T08:15:42.123Z");

describe("planInstant", () => {
  it("normalises a full date-time to a UTC instant", () => {
    expect(planInstant(undefined, "2026-07-01T08:30:00+02:00")).toBe("2026-07-01T06:30:00Z");
    expect(planInstant("1999-01-01", "2026-07-01T06:30:00.500Z")).toBe("2026-07-01T06:30:00Z");
  });

  it("reads a separate date and clock as UTC, defaulting to now", () => {
    expect(planInstant("2026-03-29", "01:30", NOW)).toBe("2026-03-29T01:30:00Z");
    expect(planInstant(undefined, "09:05:07", NOW)).toBe("2026-11-10T09:05:07Z");
    expect(planInstant("2026-12-24", undefined, NOW)).toBe("2026-12-24T08:15:42Z");
    expect(planInstant(undefined, undefined, NOW)).toBe("2026-11-10T08:15:42Z");
  });

  it.each([
    [undefined, "notaTtime"],
    [undefined, "2026-13-01T00:00:00Z"],
    [undefined, "9:30"],
    [undefined, "09:30 OR 1=1"],
    [undefined, "24:00"],
    ["2026-02-30", "08:00"],
    ["2026/02/01", "08:00"],
    ["tomorrow", undefined],
  ])("rejects date %s with time %s", (date, time) => {
    expect(planInstant(date, time, NOW)).toBeNull();
  });
});

describe("GET /plan", () => {
  function plan(query: Record<string, string>) {
    const ctx = createMockIntegrationContext();
    setup(ctx);
    const route = ctx.registered.routes.find((r) => r.method === "GET" && r.path === "/plan");
    if (!route) throw new Error("missing route");
    let status = 200;
    let body: unknown;
    const reply = {
      status: (code: number) => {
        status = code;
        return reply;
      },
      header: () => reply,
      send: (value: unknown) => {
        body = value;
        return reply;
      },
    };
    const request = {
      query: { from_lat: "50.85", from_lng: "4.35", to_lat: "51.22", to_lng: "4.42", ...query },
    };
    return Promise.resolve(route.handler(request as never, reply as never)).then(() => ({
      status,
      body,
    }));
  }

  it("answers 400, not 500, for an unparsable time", async () => {
    const result = await plan({ time: "garbageTvalue" });
    expect(result.status).toBe(400);
    expect(orchestrator.planTrip).not.toHaveBeenCalled();
  });

  it("passes a parsed instant and the unrestricted all-transit default to planners", async () => {
    orchestrator.planTrip.mockResolvedValue({ data: null, attributions: [], freshness: {} });
    await plan({ time: "2026-07-01T08:30:00+02:00", arrive_by: "true" });
    expect(orchestrator.planTrip).toHaveBeenCalledWith(
      expect.objectContaining({ arrivalTime: "2026-07-01T06:30:00Z", modes: ["TRANSIT"] }),
    );
  });
});
