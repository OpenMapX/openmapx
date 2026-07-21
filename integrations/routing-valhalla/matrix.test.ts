import { afterEach, describe, expect, it, vi } from "vitest";
import { valhallaService } from "./provider.js";

describe("valhallaService.getMatrix", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses /sources_to_targets into rows[s][t] of {seconds,km}", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return {
          ok: true,
          json: async () => ({
            sources_to_targets: [
              [
                { from_index: 0, to_index: 0, time: 0, distance: 0 },
                { from_index: 0, to_index: 1, time: 120, distance: 2.0 },
              ],
            ],
            units: "kilometers",
          }),
        };
      }),
    );

    const rows = await valhallaService.getMatrix?.(
      [[6.9, 50.9]],
      [
        [6.9, 50.9],
        [7.0, 51.0],
      ],
    );

    expect(rows?.[0]?.[0]).toEqual({ seconds: 0, km: 0 });
    expect(rows?.[0]?.[1]).toEqual({ seconds: 120, km: 2.0 });
    expect(capturedUrl).toContain("/sources_to_targets");
    expect(capturedBody.sources).toEqual([{ lat: 50.9, lon: 6.9 }]);
    expect(capturedBody.targets).toEqual([
      { lat: 50.9, lon: 6.9 },
      { lat: 51.0, lon: 7.0 },
    ]);
    expect(capturedBody.costing).toBe("auto");
  });

  it("maps a null time/distance cell to null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          sources_to_targets: [[{ from_index: 0, to_index: 0, time: null, distance: null }]],
          units: "kilometers",
        }),
      })),
    );

    const rows = await valhallaService.getMatrix?.([[6.9, 50.9]], [[6.9, 50.9]]);
    expect(rows?.[0]?.[0]).toBeNull();
  });
});
