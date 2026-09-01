import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "./reducedMotion";

const queries: string[] = [];

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => {
    queries.push(query);
    return { matches, media: query };
  });
}

describe("prefersReducedMotion", () => {
  afterEach(() => {
    queries.length = 0;
    vi.unstubAllGlobals();
  });

  it("reads the reduce media query", () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(queries).toEqual([
      "(prefers-reduced-motion: reduce)",
      "(prefers-reduced-motion: reduce)",
    ]);
  });

  it("is false where matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});
