import { describe, expect, it } from "vitest";
import { checkCacheWrites, findDirectCacheWrites } from "./check-integration-cache-writes.ts";

const lines = (source: string) => findDirectCacheWrites(source, "module.ts").map((w) => w.line);

describe("findDirectCacheWrites", () => {
  it("finds a direct set after an upstream await", () => {
    const source = [
      "export async function load(ctx) {",
      "  const data = await fetchUpstream();",
      "  await ctx.cache.set('key', data, 60);",
      "}",
    ].join("\n");
    expect(lines(source)).toEqual([3]);
  });

  it("finds a write hidden in a helper or a promise continuation", () => {
    const source = [
      "async function store(cache, value) {",
      "  await cache.set('key', value, 60);",
      "}",
      "function warm(ctx) {",
      "  fetchUpstream().then((value) => ctx.cache?.set('key', value, 60));",
      "}",
      "const set = deps.cache.set.bind(deps.cache);",
    ].join("\n");
    expect(lines(source)).toEqual([2, 5, 7]);
  });

  it("follows a cache held under another name", () => {
    const source = [
      "function a(store: CacheClient) { return store.set('k', 1); }",
      "function b(ctx) { const shared = ctx.cache; return shared.set('k', 1); }",
      "function c({ cache: kv }) { return kv.set('k', 1); }",
      "class D { constructor(private readonly kv: Pick<CacheClient, 'get' | 'set'>) {} }",
    ].join("\n");
    expect(lines(source)).toEqual([1, 2, 3]);
  });

  it("finds shared helpers that write without the fence", () => {
    const source = [
      'import { cacheSet as store, withCache as fenced } from "@openmapx/mobility-core/cache";',
      'import { withCache } from "@openmapx/core";',
      "async function load(kv) {",
      "  await store(kv, 'k', await fetchUpstream(), 60);",
      "  await withCache(kv, 'k', 60, fetchUpstream);",
      "  await fenced(kv, 'k', 60, fetchUpstream);",
      "}",
    ].join("\n");
    expect(lines(source)).toEqual([4, 5]);
  });

  it("ignores captured writers and maps named otherwise", () => {
    const source = [
      'async function load(ctx, writer: Pick<CacheClient, "set">, other: CacheWriter) {',
      "  const fenced = await captureCacheWriter(ctx.cache);",
      "  await fenced.set('k', await fetchUpstream(), 60);",
      "  await writer.set('k', 1);",
      "  await other.set('k', 1);",
      "  memCache.set('k', 1);",
      "  new Map().set('k', 1);",
      "}",
    ].join("\n");
    expect(lines(source)).toEqual([]);
  });
});

describe("checkCacheWrites", () => {
  const write = "async function f(ctx) { await ctx.cache.set('k', await up(), 1); }";

  it("fails an unlisted direct write and names its location", () => {
    const failures = checkCacheWrites(new Map([["integrations/x/index.ts", write]]), {});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("integrations/x/index.ts:1");
    expect(failures[0]).toContain("captureCacheWriter");
  });

  it("accepts a listed file only at its exact count", () => {
    const exceptions = { "integrations/x/index.ts": { count: 1, reason: "in-memory map" } };
    expect(checkCacheWrites(new Map([["integrations/x/index.ts", write]]), exceptions)).toEqual([]);
    const twice = `${write}\n${write}`;
    expect(checkCacheWrites(new Map([["integrations/x/index.ts", twice]]), exceptions)).toEqual([
      expect.stringContaining("holds 2 direct cache writes; its exception allows 1"),
    ]);
  });

  it("reports exceptions that no longer apply", () => {
    const exceptions = {
      "integrations/x/index.ts": { count: 1, reason: "converted since" },
      "integrations/gone.ts": { count: 1, reason: "deleted since" },
    };
    expect(
      checkCacheWrites(new Map([["integrations/x/index.ts", "export {};"]]), exceptions),
    ).toEqual([
      expect.stringContaining("integrations/x/index.ts no longer writes the cache directly"),
      expect.stringContaining("integrations/gone.ts is listed as an exception but does not exist"),
    ]);
  });
});
