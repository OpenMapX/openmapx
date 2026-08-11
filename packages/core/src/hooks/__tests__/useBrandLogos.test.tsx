import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { BrandDetail } from "../../types/brand";
import { useBrandLogos } from "../useBrandDetail";

function detail(qid: string, logoFile?: string): BrandDetail {
  return {
    qid,
    name: qid,
    kind: ["brand"],
    logoFile,
    matchNames: [],
    countries: [],
    tagSets: [],
    itemCount: 1,
  };
}

describe("useBrandLogos", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resolves each distinct QID to its logo filename with one hook call", async () => {
    const spy = vi.spyOn(apiClient, "get").mockImplementation(async (path: string) => {
      if (path.endsWith("Q1")) return detail("Q1", "Aldi_logo.svg");
      if (path.endsWith("Q2")) return detail("Q2");
      throw new Error(`unexpected path ${path}`);
    });

    const { result } = renderHook(() => useBrandLogos(["Q1", "Q2"]), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.get("Q1")).toBe("Aldi_logo.svg"));

    expect(result.current.size).toBe(2);
    expect(result.current.get("Q2")).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns an empty map without any request when there are no QIDs", () => {
    const spy = vi.spyOn(apiClient, "get");

    const { result } = renderHook(() => useBrandLogos([]), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
