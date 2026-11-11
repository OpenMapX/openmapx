type Exclusions = { points: [number, number][]; polygons: [number, number][][] };

type Closures = typeof import("../../closures.js");

let stubbed: Exclusions | undefined;

/**
 * Make every closure lookup also return this exclusion geometry; none clears
 * it. No road-conditions source yields engine exclusion geometry any more, but
 * the engine-facing exclusion inputs stay a generic capability of the routing
 * layer, so tests for it supply the geometry here. A test file that stubs
 * exclusions mocks the closures module with `withStubbedClosureExclusions`
 * itself, so the mock is hoisted above every import that reaches it.
 */
export function stubClosureExclusions(exclusions?: Partial<Exclusions>): void {
  stubbed = exclusions ? { points: [], polygons: [], ...exclusions } : undefined;
}

/** The closures module with its lookup carrying the stubbed exclusions; for `vi.mock`. */
export function withStubbedClosureExclusions(original: Closures): Closures {
  return {
    ...original,
    activeClosuresForBbox: async (...args) => {
      const result = await original.activeClosuresForBbox(...args);
      return stubbed ? { ...result, ...stubbed } : result;
    },
  };
}
