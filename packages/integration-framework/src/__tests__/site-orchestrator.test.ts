import type { BBox } from "@openmapx/core";
import { describe, expect, test, vi } from "vitest";
import type { IntegrationContext } from "../context";
import {
  createSiteOrchestrator,
  selectedOptions,
  siteAttributions,
  withinZoom,
  wrapSiteResult,
} from "../site-orchestrator";

interface Site {
  id: string;
  sources: string[];
  attributions: { sourceId: string; name: string }[];
}
interface Query {
  excludedSourceIds?: readonly string[];
  hint?: string;
}
interface Provider {
  id: string;
  coverage?: { bbox: BBox } | { all: true };
  list(bbox: BBox, q?: Query): Promise<{ items: Site[]; partial?: "area" | "unavailable" }>;
  one(id: string, q?: Query): Promise<Site | null>;
}

const BBOX: BBox = [8.38, 49.0, 8.42, 49.02];

function site(id: string, sources = ["src-a"]): Site {
  return { id, sources, attributions: sources.map((s) => ({ sourceId: s, name: s })) };
}

function provider(id: string, sites: Site[] | Error, over: Partial<Provider> = {}): Provider {
  return {
    id,
    list: vi.fn(async () => {
      if (sites instanceof Error) throw sites;
      return { items: sites };
    }),
    one: vi.fn(async (siteId: string) =>
      sites instanceof Error ? null : (sites.find((s) => s.id === siteId) ?? null),
    ),
    ...over,
  };
}

function ctxWith(providers: Provider[], disallowed?: string[], lines: string[] = []) {
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "test-sites"
        ? providers.map((p) => ({ id: p.id, providers: new Map([["test-sites", [p]]]) }))
        : [],
    getDisallowedSourceIds: disallowed ? async () => new Set(disallowed) : undefined,
    log: {
      warn: (m: string) => lines.push(`warn ${m}`),
      info: (m: string) => lines.push(`info ${m}`),
      debug: (m: string) => lines.push(`debug ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
    },
  } as unknown as IntegrationContext;
}

function orchestrator(ctx: IntegrationContext) {
  return createSiteOrchestrator<Provider, Site, Query>(ctx, {
    domain: "test-sites",
    logPrefix: "test",
    search: {
      name: "list",
      run: async (p, bbox, q) => {
        const { items, partial } = await p.list(bbox, q);
        return partial ? { sites: items, partial } : { sites: items };
      },
    },
    get: { name: "one", run: (p, id, q) => p.one(id, q) },
  });
}

describe("site orchestrator", () => {
  test("merges providers, keeps the area reason over unavailable, and logs an outage once", async () => {
    const lines: string[] = [];
    const ctx = ctxWith(
      [
        provider("a", [site("a:1")]),
        provider("b", new Error("down")),
        provider("c", [], {
          list: vi.fn(async () => ({ items: [site("c:1")], partial: "area" as const })),
        }),
        provider("far", [site("far:1")], { coverage: { bbox: [2, 48, 3, 49] } }),
      ],
      undefined,
      lines,
    );
    const sites = orchestrator(ctx);

    const first = await sites.search(BBOX, { hint: "x" });
    await sites.search(BBOX);

    expect(first.sites.map((s) => s.id)).toEqual(["a:1", "c:1"]);
    expect(first.partial).toBe("area");
    expect(lines.filter((l) => l.startsWith("warn"))).toEqual([
      "warn [test] provider b failed list: down",
    ]);
    expect(sites.providers().map((p) => p.id)).toEqual(["a", "b", "c", "far"]);
  });

  test("pushes disallowed sources into the query and filters them again, on search and find", async () => {
    const a = provider("a", [site("ok"), site("merged", ["src-a", "src-x"])]);
    const sites = orchestrator(ctxWith([a], ["src-x"]));

    expect((await sites.search(BBOX, { hint: "h" })).sites.map((s) => s.id)).toEqual(["ok"]);
    expect(vi.mocked(a.list).mock.calls[0][1]).toEqual({ hint: "h", excludedSourceIds: ["src-x"] });
    expect(await sites.find("merged")).toBeNull();
    expect(a.one).toHaveBeenCalledWith("merged", { excludedSourceIds: ["src-x"] });
    expect((await sites.find("ok"))?.id).toBe("ok");
  });

  test("with no provider the search is empty and find is null", async () => {
    const sites = orchestrator(ctxWith([]));
    expect(await sites.search(BBOX)).toEqual({ sites: [] });
    expect(await sites.find("a")).toBeNull();
  });

  test("the shared data-source helpers", () => {
    expect(withinZoom({ west: 8.3, south: 48.95, east: 8.5, north: 49.07 }, 12)).toBe(true);
    expect(withinZoom({ west: 0, south: 45, east: 15, north: 56 }, 8)).toBe(false);
    expect([...selectedOptions({ a: ["x", "y"], b: "z", c: "" }, "a")]).toEqual(["x", "y"]);
    expect([...selectedOptions({ b: "z" }, "b")]).toEqual(["z"]);
    expect(selectedOptions({ c: "" }, "c").size).toBe(0);
    expect(
      siteAttributions([
        { attributions: [{ sourceId: "s", name: "A" }] },
        {
          attributions: [
            { sourceId: "s", name: "A" },
            { sourceId: "s", name: "B" },
          ],
        },
      ]),
    ).toEqual([
      { sourceId: "s", name: "A" },
      { sourceId: "s", name: "B" },
    ]);
  });

  test("the envelope keeps only http(s) attribution links", () => {
    const upstream = {
      sourceId: "s",
      name: "A",
      url: "javascript:alert(1)",
      licenseUrl: "data:text/html,x",
      publisher: { name: "P", url: "javascript:alert(2)" },
    };
    const safe = {
      sourceId: "t",
      name: "B",
      url: "https://example.org",
      licenseUrl: "http://example.org/licence",
      publisher: { name: "Q", url: "https://example.org/q" },
    };

    expect(siteAttributions([{ attributions: [upstream, safe] }])).toEqual([
      { sourceId: "s", name: "A", publisher: { name: "P" } },
      safe,
    ]);
    expect(wrapSiteResult(null, [upstream, safe]).attributions).toEqual([
      { sourceId: "s", name: "A", publisher: { name: "P" } },
      safe,
    ]);
  });
});
