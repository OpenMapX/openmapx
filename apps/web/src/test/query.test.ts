import { describe, expect, it } from "vitest";
import { createTestQueryClient } from "./query";

describe("web query test utilities", () => {
  it("disables retries and cross-test caching", () => {
    expect(createTestQueryClient().getDefaultOptions()).toEqual({
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    });
  });
});
