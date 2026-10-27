import { afterEach, describe, expect, it, vi } from "vitest";
import { overpassPoiSearch } from "../overpass.service";
import {
  isOverpassRuntimeLimit,
  OverpassRateLimitError,
  OverpassTimeoutError,
  OverpassUnavailableError,
  overpassQuery,
  setOverpassContributorResolver,
  setOverpassUrl,
} from "./client";

const QUERY = "[out:json];node(1);out;";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setOverpassUrl(undefined);
  setOverpassContributorResolver();
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

  it("captures only the actual fallback supplier before acquisition, not a later catalogue or upstream claim", async () => {
    const pending = Promise.withResolvers<Response>();
    const primary = { sourceId: "primary", name: "Unused primary" };
    const fallback = {
      sourceId: "fallback",
      name: "Original fallback",
      publisher: { name: "Original publisher" },
    };
    setOverpassContributorResolver((url) => (url.includes("kumi") ? [fallback] : [primary]));
    vi.stubEnv("OVERPASS_URL", "");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 504 }))
      .mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const work = overpassPoiSearch(QUERY);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fallback.publisher.name = "Changed catalogue";
    pending.resolve(
      new Response(
        JSON.stringify({
          elements: [{ type: "node", id: 1, lat: 50, lon: 6, tags: { name: "Station" } }],
          contributors: [primary],
        }),
      ),
    );
    const result = await work;
    expect(result.results[0]?.contributors).toEqual([
      { ...fallback, publisher: { name: "Original publisher" } },
    ]);
    expect(result.results[0]?.contributors?.some((row) => row.sourceId === "primary")).toBe(false);
  });

  it("keeps other failures as they are", async () => {
    setOverpassUrl("http://overpass.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));

    await expect(overpassQuery(QUERY)).rejects.toThrow("Overpass API error: 500");
  });
});

/**
 * The page Overpass's osm3s writes, with HTTP 200, when it can't run a
 * query, here with the error openmapx.com's dispatcher gave for a repeated
 * query string while OVERPASS_ALLOW_DUPLICATE_QUERIES was `no`.
 */
const errorPage = (error: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"
    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <meta http-equiv="content-type" content="text/html; charset=utf-8" lang="en"/>
  <title>OSM3S Response</title>
</head>
<body>

<p>The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.</p>
<p><strong style="color:#FF0000">Error</strong>: ${error} </p>

</body>
</html>
`;
const DUPLICATE_QUERY =
  "runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::duplicate_query";

describe("an answer that is Overpass's error page, not JSON", () => {
  const answer = (body: string) => {
    setOverpassUrl("http://overpass.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    return overpassQuery(QUERY);
  };

  it("is unavailable when the dispatcher refuses a repeated query, with its text, never a SyntaxError", async () => {
    const refused = answer(errorPage(DUPLICATE_QUERY));
    await expect(refused).rejects.toBeInstanceOf(OverpassUnavailableError);
    await expect(answer(errorPage(DUPLICATE_QUERY))).rejects.toThrow(
      `Overpass API unavailable: ${DUPLICATE_QUERY}`,
    );
    await expect(answer(errorPage(DUPLICATE_QUERY))).rejects.not.toBeInstanceOf(SyntaxError);
  });

  it("from the public server, tries the public mirror, as for a 504", async () => {
    vi.stubEnv("OVERPASS_URL", "");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(errorPage(DUPLICATE_QUERY), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ elements: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(overpassQuery(QUERY)).resolves.toMatchObject({ elements: [] });
    expect(fetchMock.mock.calls[1]?.[0]).toContain("kumi");
  });

  it("is a timeout or a rate limit when it says so, as the status or remark would", async () => {
    await expect(
      answer(errorPage('runtime error: Query timed out in "query" at line 1 after 26 seconds.')),
    ).rejects.toBeInstanceOf(OverpassTimeoutError);
    await expect(
      answer(
        errorPage(
          "runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::rate_limited",
        ),
      ),
    ).rejects.toBeInstanceOf(OverpassRateLimitError);
  });

  it("keeps any other error's text, decoded, and says when a body is neither JSON nor such a page", async () => {
    await expect(
      answer(errorPage("line 1: parse error: Unknown type &quot;nod&quot;")),
    ).rejects.toThrow('Overpass API error: line 1: parse error: Unknown type "nod"');
    await expect(answer("<p>Bad Gateway</p>")).rejects.toThrow(
      "Overpass API answered with a body that is neither JSON nor an error page",
    );
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
