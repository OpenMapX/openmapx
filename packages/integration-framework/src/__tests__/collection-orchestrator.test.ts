import type { BBox } from "@openmapx/core";
import { describe, expect, test, vi } from "vitest";
import { createCollectionOrchestrator } from "../collection-orchestrator";
import type { IntegrationContext } from "../context";

interface Item {
  id: string;
  sources: string[];
}
interface Query {
  excludedSourceIds?: readonly string[];
  hint?: string;
}
interface Provider {
  id: string;
  coverage?: { bbox: BBox } | { all: true };
  list(bbox: BBox, q: Query): Promise<{ items: Item[]; partial?: "area" | "unavailable" }>;
}

const BBOX: BBox = [8.38, 49.0, 8.42, 49.02];

function provider(id: string, result: Item[] | Error, over: Partial<Provider> = {}): Provider {
  return {
    id,
    list: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return { items: result };
    }),
    ...over,
  };
}

function ctxWith(providers: Provider[], disallowed?: string[], lines: string[] = []) {
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "test-items"
        ? providers.map((p) => ({ id: p.id, providers: new Map([["test-items", [p]]]) }))
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

function collection(ctx: IntegrationContext) {
  return createCollectionOrchestrator<Provider, Item, Query>(ctx, {
    domain: "test-items",
    logPrefix: "test",
    name: "list",
    run: (p, bbox, q) => p.list(bbox, q),
    sourcesOf: (item) => item.sources,
  });
}

describe("collection orchestrator", () => {
  test("pushes the disallowed sources into the query and drops an item naming one", async () => {
    const a = provider("a", [
      { id: "ok", sources: ["src-a"] },
      { id: "merged", sources: ["src-a", "src-x"] },
    ]);
    const items = collection(ctxWith([a], ["src-x"]));

    const answer = await items.read(BBOX, { hint: "h", excludedSourceIds: ["src-y"] });

    expect(answer.items.map((i) => i.id)).toEqual(["ok"]);
    expect(vi.mocked(a.list).mock.calls[0][1]).toEqual({
      hint: "h",
      excludedSourceIds: ["src-y", "src-x"],
    });
  });

  test("a failing provider sets unavailable and area wins over it", async () => {
    const lines: string[] = [];
    const items = collection(
      ctxWith(
        [
          provider("a", [{ id: "a:1", sources: ["s"] }]),
          provider("down", new Error("down")),
          provider("far", [{ id: "far:1", sources: ["s"] }], {
            coverage: { bbox: [2, 48, 3, 49] },
          }),
        ],
        undefined,
        lines,
      ),
    );

    expect(await items.read(BBOX)).toEqual({
      items: [{ id: "a:1", sources: ["s"] }],
      partial: "unavailable",
    });
    await items.read(BBOX);
    expect(lines.filter((l) => l.startsWith("warn"))).toEqual([
      "warn [test] provider down failed list: down",
    ]);

    const withArea = collection(
      ctxWith([
        provider("down", new Error("down")),
        provider("part", [], {
          list: vi.fn(async () => ({ items: [], partial: "area" as const })),
        }),
      ]),
    );
    expect((await withArea.read(BBOX)).partial).toBe("area");
  });

  test("with no provider the read is empty", async () => {
    expect(await collection(ctxWith([])).read(BBOX)).toEqual({ items: [] });
  });
});
