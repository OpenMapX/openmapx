import { describe, expect, it } from "vitest";
import { LRU } from "../web/lru";

describe("LRU", () => {
  it("evicts the least recently used entry beyond its bound", () => {
    const cache = new LRU<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("refreshes an entry on set and supports delete and clear", () => {
    const cache = new LRU<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    cache.set("c", 3);
    expect([...cache.keys()]).toEqual(["a", "c"]);
    cache.delete("a");
    expect(cache.has("a")).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("returns undefined for a missing key", () => {
    expect(new LRU<string, number>(1).get("x")).toBeUndefined();
  });
});
