import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
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

    await waitFor(() => expect(result.current.get("Q1")?.logoFile).toBe("Aldi_logo.svg"));

    expect(result.current.size).toBe(2);
    expect(result.current.get("Q2")?.logoFile).toBeUndefined();
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

it("keeps a complete cached logo and its captured credit during a failed refresh", async () => {
  const { useBrandLogoAttribution } = await import("../useBrandDetail");
  const { createTestQueryClient } = await import("../../test/queryWrapper");
  const client = createTestQueryClient();
  const photo = {
    logoFile: "Logo.svg",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo.svg",
    source: "wikimedia-commons",
    author: "Cached artist",
    licensing: licensingFromDeclaration(
      "CC BY 4.0",
      "https://creativecommons.org/licenses/by/4.0/",
    ),
    pageUrl: "https://commons.wikimedia.org/wiki/File:Logo.svg",
    contributors: [{ sourceId: "wikimedia-commons", name: "Cached file receipt" }],
  };
  client.setQueryDefaults(["brand-logo-attribution-v3"], { retryDelay: 0 });
  client.setQueryData(["brand-logo-attribution-v3", "Q1"], photo);
  const get = vi.spyOn(apiClient, "get").mockRejectedValue(new Error("metadata unavailable"));
  try {
    const { result } = renderHook(() => useBrandLogoAttribution("Q1", true), {
      wrapper: createQueryWrapper(client),
    });
    expect(result.current.data).toEqual(photo);
    const refreshed = await result.current.refetch();
    expect(get).toHaveBeenCalled();
    expect(refreshed.isRefetchError).toBe(true);
    expect(result.current.data?.contributors).toEqual(photo.contributors);
    expect(result.current.data?.author).toBe("Cached artist");
  } finally {
    get.mockRestore();
  }
});

it("preserves the selected logo file's captured catalogue receipt", async () => {
  const row = {
    ...detail("Q3", "Logo.svg"),
    contributors: [{ sourceId: "wikidata", name: "Captured filename source" }],
    fieldContributors: { logoFile: [{ sourceId: "wikidata", name: "Captured filename source" }] },
  };
  const get = vi.spyOn(apiClient, "get").mockResolvedValue(row);
  try {
    const { result } = renderHook(() => useBrandLogos(["Q3"]), { wrapper: createQueryWrapper() });
    await waitFor(() =>
      expect(result.current.get("Q3")).toMatchObject({
        logoFile: "Logo.svg",
        fieldContributors: row.fieldContributors,
      }),
    );
  } finally {
    get.mockRestore();
  }
});
