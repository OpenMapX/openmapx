import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { API_ENDPOINTS } from "../../api/endpoints";
import { createQueryWrapper } from "../../test/queryWrapper";
import type { BoundingBox } from "../../types/geometry";
import { useNlpSearch } from "../useNlpSearch";

const center: [number, number] = [13.4, 52.5];
const bbox: BoundingBox = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };

describe("useNlpSearch", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts the query and map context to the parse endpoint", async () => {
    const response = { intent: {}, resolvedBbox: bbox, provider: "local", cached: false };
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue(response as never);

    const { result } = renderHook(() => useNlpSearch("coffee near me", center, bbox, true, "en"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.nlpParse,
      {
        query: "coffee near me",
        mapCenter: center,
        mapBbox: bbox,
        lang: "en",
        cloudAccess: "deny",
      },
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 8_000 }),
    );
  });

  it("includes explicit consent in the body when granted", async () => {
    const spy = vi
      .spyOn(apiClient, "post")
      .mockResolvedValue({ provider: "local", cached: false } as never);

    const { result } = renderHook(
      () => useNlpSearch("pizza places", center, bbox, true, undefined, "consented"),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      API_ENDPOINTS.nlpParse,
      expect.objectContaining({ cloudAccess: "consented" }),
      expect.objectContaining({ signal: expect.anything(), timeoutMs: 8_000 }),
    );
  });

  describe("result identity", () => {
    const zoomedBbox: BoundingBox = { south: 52.45, west: 13.35, north: 52.55, east: 13.45 };

    function renderNlp(
      initial: { bbox: BoundingBox | null; lang?: string; cloudAccess?: "deny" | "consented" },
      post: ReturnType<typeof vi.spyOn>,
    ) {
      return {
        post,
        ...renderHook(
          (props: typeof initial) =>
            useNlpSearch("coffee near me", center, props.bbox, true, props.lang, props.cloudAccess),
          { initialProps: initial, wrapper: createQueryWrapper() },
        ),
      };
    }

    it.each([
      ["in", zoomedBbox],
      ["out", { west: 12.4, south: 51.5, east: 14.4, north: 53.5 }],
    ])(
      "searches the new visible area when zooming %s with the same center",
      async (_direction, changedBbox) => {
        const post = vi
          .spyOn(apiClient, "post")
          .mockImplementation(
            async (_url, body) =>
              ({ intent: {}, resolvedBbox: (body as { mapBbox: BoundingBox }).mapBbox }) as never,
          );

        const { result, rerender } = renderNlp({ bbox }, post);
        await waitFor(() => expect(result.current.data?.resolvedBbox).toEqual(bbox));

        rerender({ bbox: changedBbox });

        await waitFor(() => expect(result.current.data?.resolvedBbox).toEqual(changedBbox));
        expect(post).toHaveBeenCalledTimes(2);
        expect(post).toHaveBeenLastCalledWith(
          API_ENDPOINTS.nlpParse,
          expect.objectContaining({ mapBbox: changedBbox }),
          expect.anything(),
        );
      },
    );

    it("reuses the cached result for an equal bounds value in a new object", async () => {
      const post = vi.spyOn(apiClient, "post").mockResolvedValue({ resolvedBbox: bbox } as never);

      const { result, rerender } = renderNlp({ bbox }, post);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      rerender({ bbox: { ...bbox } });

      expect(result.current.isSuccess).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it("restores the earlier result when the bounds return to a cached value", async () => {
      const post = vi
        .spyOn(apiClient, "post")
        .mockImplementation(
          async (_url, body) =>
            ({ resolvedBbox: (body as { mapBbox: BoundingBox }).mapBbox }) as never,
        );

      const { result, rerender } = renderNlp({ bbox }, post);
      await waitFor(() => expect(result.current.data?.resolvedBbox).toEqual(bbox));
      rerender({ bbox: zoomedBbox });
      await waitFor(() => expect(result.current.data?.resolvedBbox).toEqual(zoomedBbox));

      rerender({ bbox: { ...bbox } });

      expect(result.current.data?.resolvedBbox).toEqual(bbox);
      expect(post).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["south", { ...bbox, south: 52.41 }],
      ["west", { ...bbox, west: 13.31 }],
      ["north", { ...bbox, north: 52.61 }],
      ["east", { ...bbox, east: 13.51 }],
    ])("treats a changed %s edge as a different search", async (_edge, changed) => {
      const post = vi
        .spyOn(apiClient, "post")
        .mockImplementation(
          async (_url, body) =>
            ({ resolvedBbox: (body as { mapBbox: BoundingBox }).mapBbox }) as never,
        );

      const { result, rerender } = renderNlp({ bbox }, post);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      rerender({ bbox: changed });

      await waitFor(() => expect(result.current.data?.resolvedBbox).toEqual(changed));
      expect(post).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenLastCalledWith(
        API_ENDPOINTS.nlpParse,
        expect.objectContaining({ mapBbox: changed }),
        expect.anything(),
      );
    });

    it("keeps cloud consent states separate for the same bounds", async () => {
      const post = vi.spyOn(apiClient, "post").mockResolvedValue({ resolvedBbox: bbox } as never);

      const { result, rerender } = renderNlp({ bbox, cloudAccess: "deny" }, post);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      rerender({ bbox, cloudAccess: "consented" });

      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      expect(post).toHaveBeenLastCalledWith(
        API_ENDPOINTS.nlpParse,
        expect.objectContaining({ cloudAccess: "consented" }),
        expect.anything(),
      );
    });

    it("keeps languages separate for the same bounds", async () => {
      const post = vi.spyOn(apiClient, "post").mockResolvedValue({ resolvedBbox: bbox } as never);

      const { result, rerender } = renderNlp({ bbox, lang: "en" }, post);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      rerender({ bbox, lang: "de" });

      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    });

    it("does not fire without bounds", () => {
      const post = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

      const { result } = renderNlp({ bbox: null }, post);

      expect(result.current.fetchStatus).toBe("idle");
      expect(post).not.toHaveBeenCalled();
    });

    it("cancels the in-flight request when the bounds change", async () => {
      const signals: AbortSignal[] = [];
      const post = vi.spyOn(apiClient, "post").mockImplementation(
        (_url, body, options) =>
          new Promise((resolve, reject) => {
            const signal = options?.signal as AbortSignal;
            signals.push(signal);
            signal.addEventListener("abort", () => reject(new Error("aborted")));
            if ((body as { mapBbox: BoundingBox }).mapBbox === zoomedBbox) {
              resolve({ resolvedBbox: zoomedBbox } as never);
            }
          }),
      );

      const { result, rerender } = renderNlp({ bbox }, post);
      await waitFor(() => expect(signals).toHaveLength(1));
      rerender({ bbox: zoomedBbox });

      await waitFor(() => expect(result.current.data?.resolvedBbox).toEqual(zoomedBbox));
      expect(signals[0]?.aborted).toBe(true);
    });
  });

  it("does not fire when disabled", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const { result } = renderHook(() => useNlpSearch("coffee shops", center, bbox, false), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not parse changed bounds while disabled", () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);
    const { result, rerender } = renderHook(
      ({ bounds }) => useNlpSearch("coffee shops", center, bounds, false),
      { initialProps: { bounds: bbox }, wrapper: createQueryWrapper() },
    );
    rerender({ bounds: { west: 12.4, south: 51.5, east: 14.4, north: 53.5 } });
    expect(result.current.fetchStatus).toBe("idle");
    expect(post).not.toHaveBeenCalled();
  });

  it("does not fire for queries shorter than 4 characters", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const { result } = renderHook(() => useNlpSearch("abc", center, bbox, true), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fire when map context is missing", () => {
    const spy = vi.spyOn(apiClient, "post").mockResolvedValue({} as never);

    const { result } = renderHook(() => useNlpSearch("coffee shops", null, bbox, true), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(spy).not.toHaveBeenCalled();
  });
});
