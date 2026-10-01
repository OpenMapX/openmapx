import { afterEach, describe, expect, it, vi } from "vitest";
import { overpassPoiSearch } from "../overpass.service";
import {
  isOverpassRuntimeLimit,
  OverpassTimeoutError,
  OverpassUnavailableError,
  overpassQuery,
  setOverpassUrl,
} from "./client";

const QUERY = "[out:json];node(1);out;";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setOverpassUrl(undefined);
});

describe("overpassQuery", () => {
  it("reports a server that does not answer in time as unavailable, not as a 500", async () => {
    setOverpassUrl("http://overpass.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")),
    );

    await expect(overpassQuery(QUERY)).rejects.toBeInstanceOf(OverpassUnavailableError);
  });

  it("tries the public mirror when the default server is too busy, and gives up if it is too", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 504 }))
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OVERPASS_URL", "");

    await expect(overpassQuery(QUERY)).rejects.toBeInstanceOf(OverpassUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps other failures as they are", async () => {
    setOverpassUrl("http://overpass.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));

    await expect(overpassQuery(QUERY)).rejects.toThrow("Overpass API error: 500");
  });
});

describe("a query that ran out of its limits", () => {
  it("is recognised by Overpass's remark", () => {
    expect(
      isOverpassRuntimeLimit(
        'runtime error: Query timed out in "query" at line 3 after 16 seconds.',
      ),
    ).toBe(true);
    expect(
      isOverpassRuntimeLimit("runtime error: Query run out of memory using about 2048 MB"),
    ).toBe(true);
    expect(isOverpassRuntimeLimit(undefined)).toBe(false);
    expect(isOverpassRuntimeLimit("runtime remark: Timeout is 15 and maxsize is 536870912.")).toBe(
      false,
    );
  });

  it("makes a POI search ask for a smaller area instead of passing partial results off as all", async () => {
    setOverpassUrl("http://overpass.test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          elements: [{ type: "node", id: 1, lat: 1, lon: 1, tags: { name: "A" } }],
          remark: 'runtime error: Query timed out in "query" at line 3 after 16 seconds.',
        }),
      ),
    );

    await expect(overpassPoiSearch(QUERY)).rejects.toBeInstanceOf(OverpassTimeoutError);
  });
});
