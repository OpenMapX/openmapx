import { afterEach, describe, expect, it, vi } from "vitest";
import { valhallaHarness } from "./__tests__/valhalla-http.js";

const valhalla = valhallaHarness();

describe("valhalla.service.getMatrix", () => {
  afterEach(() => {});

  it("parses /sources_to_targets into rows[s][t] of {seconds,km}", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    valhalla.answer = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return Response.json({
        sources_to_targets: [
          [
            { from_index: 0, to_index: 0, time: 0, distance: 0 },
            { from_index: 0, to_index: 1, time: 120, distance: 2.0 },
          ],
        ],
        units: "kilometers",
      });
    });

    const rows = await valhalla.service.getMatrix?.(
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
    valhalla.answer = vi.fn(async () =>
      Response.json({
        sources_to_targets: [[{ from_index: 0, to_index: 0, time: null, distance: null }]],
        units: "kilometers",
      }),
    );

    const rows = await valhalla.service.getMatrix?.([[6.9, 50.9]], [[6.9, 50.9]]);
    expect(rows?.[0]?.[0]).toBeNull();
  });
});

describe("Valhalla generations", () => {
  it("sends each generation's own key and endpoint", async () => {
    const first = valhallaHarness();
    const second = valhallaHarness();
    const urls: string[] = [];
    const answer = async (url: string) => {
      urls.push(url);
      return Response.json({ sources_to_targets: [[]], units: "kilometers" });
    };
    first.answer = answer;
    second.answer = answer;
    first.settings = {
      url: "https://api.stadiamaps.com",
      apiKey: "first",
      bidirectionalAlternates: true,
    };
    second.settings = { url: "http://valhalla:8002", bidirectionalAlternates: true };

    await first.service.getMatrix?.([[6.9, 50.9]], [[6.9, 50.9]]);
    await second.service.getMatrix?.([[6.9, 50.9]], [[6.9, 50.9]]);

    expect(urls).toEqual([
      "https://api.stadiamaps.com/sources_to_targets?api_key=first",
      "http://valhalla:8002/sources_to_targets",
    ]);
  });
});
