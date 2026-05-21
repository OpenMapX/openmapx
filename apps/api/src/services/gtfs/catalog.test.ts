import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GITHUB_TREE_URL =
  "https://api.github.com/repos/public-transport/transitous/git/trees/main?recursive=1";

// Stub out integration-host so importing ./catalog doesn't transitively pull in
// auth.ts (which requires BETTER_AUTH_SECRET). The catalog merger only uses
// integration-host to discover gtfs-catalog domain providers (e.g. the MDB
// integration); returning an empty list keeps the Transitous + Swiss-only path
// of this test intact.
vi.mock("../../integration-host.js", () => ({
  getIntegrationsByDomain: vi.fn().mockReturnValue([]),
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-22T10:00:00.000Z"));
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === GITHUB_TREE_URL) {
      return new Response(JSON.stringify({ tree: [] }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gtfs catalog", () => {
  it("injects the official Swiss GTFS feed alongside Transitous entries", async () => {
    vi.resetModules();
    const { searchCatalog } = await import("./catalog");

    const feeds = await searchCatalog(undefined, "ch");

    expect(feeds).toEqual([
      expect.objectContaining({
        id: "opentransportdata-swiss:ch:timetable-2026-gtfs2020",
        name: "Switzerland Timetable 2026 (GTFS2020)",
        source: "opentransportdata-swiss",
        countryCode: "ch",
        url: "https://data.opentransportdata.swiss/en/dataset/timetable-2026-gtfs2020/permalink",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      GITHUB_TREE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": expect.any(String) }),
      }),
    );
  });
});
