import {
  createQueryWrapper as createCoreQueryWrapper,
  createTestQueryClient as createCoreTestQueryClient,
} from "@openmapx/core/test/query";
import { describe, expect, it } from "vitest";
import { createQueryWrapper, createTestQueryClient } from "./query";

describe("web query test utilities", () => {
  it("uses the core testing-only query helpers", () => {
    expect(createQueryWrapper).toBe(createCoreQueryWrapper);
    expect(createTestQueryClient).toBe(createCoreTestQueryClient);
  });

  it("disables retries and cross-test caching", () => {
    expect(createTestQueryClient().getDefaultOptions()).toEqual({
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    });
  });
});
