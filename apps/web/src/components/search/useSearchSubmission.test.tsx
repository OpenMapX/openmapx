import {
  useDirectionsStore,
  usePlaceStore,
  useSearchStore,
  useSettingsStore,
  useStreetLevelStore,
} from "@openmapx/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchBarSurface } from "./searchSubmission";
import { useSearchSubmission } from "./useSearchSubmission";

const nlp = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useNlpSearch: (...args: unknown[]) => nlp(...args),
}));

const viewport = {
  mapCenter: [13, 52] as [number, number],
  mapBbox: { west: 12, south: 51, east: 14, north: 53 },
};
type Viewport = ReturnType<Parameters<typeof useSearchSubmission>[0]["captureViewport"]>;
function options(surface: SearchBarSurface = "map") {
  return {
    surface,
    query: "quiet cafes",
    locale: "en",
    directionsOpen: false,
    captureViewport: (): Viewport => viewport,
    executeResolvedSubmit: vi.fn(),
    cancelEnrichment: vi.fn(),
    blurInput: vi.fn(),
    searchText: vi.fn(),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useSearchStore.setState({ query: "quiet cafes", isFocused: true });
  useSettingsStore.setState({ aiSearchEnabled: true });
  useDirectionsStore.getState().close();
  useStreetLevelStore.getState().closeViewer();
  usePlaceStore.getState().setSelectedPlace(null);
  nlp.mockReset().mockReturnValue({ data: undefined, isFetching: true, isError: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("search submission lifetime", () => {
  it("captures the viewport once and resolves pending Enter exactly at its deadline", () => {
    const props = options();
    vi.spyOn(props, "captureViewport");
    const view = renderHook(() => useSearchSubmission(props));
    let captured!: ReturnType<typeof view.result.current.beginSubmission>;
    act(() => {
      captured = view.result.current.beginSubmission();
      view.result.current.deferSubmission(captured);
    });
    expect(captured).toMatchObject({
      ...viewport,
      query: "quiet cafes",
      aiSearchEnabled: true,
      selectionRevision: usePlaceStore.getState().selectionRevision,
    });
    expect(props.captureViewport).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2499));
    expect(props.executeResolvedSubmit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(props.executeResolvedSubmit).toHaveBeenCalledTimes(1);
    expect(props.executeResolvedSubmit).toHaveBeenCalledWith(captured);
    act(() => {
      view.result.current.settlePending();
      vi.advanceTimersByTime(3000);
    });
    expect(props.executeResolvedSubmit).toHaveBeenCalledTimes(1);
    expect(view.result.current.pending).toBe(false);
  });

  it("uses the current committed results action without restarting the deadline", () => {
    const props = options();
    const next = vi.fn();
    const view = renderHook((p) => useSearchSubmission(p), { initialProps: props });
    act(() => view.result.current.deferSubmission(view.result.current.beginSubmission()));
    act(() => vi.advanceTimersByTime(2000));
    view.rerender({ ...props, executeResolvedSubmit: next });
    act(() => vi.advanceTimersByTime(500));
    expect(next).toHaveBeenCalledTimes(1);
    expect(props.executeResolvedSubmit).not.toHaveBeenCalled();
  });

  it("settles early once and rejects superseded execution contexts", () => {
    const props = options();
    const view = renderHook(() => useSearchSubmission(props));
    let old!: ReturnType<typeof view.result.current.beginSubmission>;
    act(() => {
      old = view.result.current.beginSubmission();
      view.result.current.deferSubmission(old);
    });
    act(() => {
      const current = view.result.current.beginSubmission();
      view.result.current.deferSubmission(current);
      view.result.current.runSubmission(old);
      view.result.current.settlePending();
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(props.executeResolvedSubmit).toHaveBeenCalledTimes(1);
    expect(props.executeResolvedSubmit.mock.calls[0]?.[0]).not.toBe(old);
  });

  it.each(["query", "AI", "Directions", "selection", "viewer"])(
    "keeps %s ABA cancellation final before React flushes",
    (cause) => {
      const props = options();
      const view = renderHook(() => useSearchSubmission(props));
      act(() => view.result.current.deferSubmission(view.result.current.beginSubmission()));
      act(() => {
        if (cause === "query") {
          useSearchStore.setState({ query: "tea" });
          useSearchStore.setState({ query: props.query });
        }
        if (cause === "AI") {
          useSettingsStore.setState({ aiSearchEnabled: false });
          useSettingsStore.setState({ aiSearchEnabled: true });
        }
        if (cause === "Directions") {
          useDirectionsStore.getState().open();
          useDirectionsStore.getState().close();
        }
        if (cause === "selection") {
          usePlaceStore.getState().setSelectedPlace(null);
        }
        if (cause === "viewer") {
          useStreetLevelStore.setState({
            activeImage: { providerId: "synthetic", imageId: "1" },
          });
          useStreetLevelStore.getState().closeViewer();
        }
        view.result.current.settlePending();
        vi.advanceTimersByTime(3000);
      });
      expect(props.executeResolvedSubmit).not.toHaveBeenCalled();
      expect(view.result.current.pending).toBe(false);
    },
  );

  it("cancels pending Enter on blur without cancelling an active NLP request", () => {
    const view = renderHook(() => useSearchSubmission(options()));
    act(() => {
      const context = view.result.current.beginSubmission();
      expect(view.result.current.startNlp(context)).toBe(true);
    });
    expect(nlp.mock.calls.at(-1)?.[3]).toBe(true);
    act(() => view.result.current.cancelPending());
    expect(nlp.mock.calls.at(-1)?.[3]).toBe(true);
    act(() => view.result.current.cancelSubmission());
    expect(nlp.mock.calls.at(-1)?.[3]).toBe(false);
  });

  it("does not send short, disabled or viewport-less submissions to NLP", () => {
    const props = options();
    const view = renderHook((p) => useSearchSubmission(p), { initialProps: props });
    useSettingsStore.setState({ aiSearchEnabled: false });
    act(() =>
      expect(view.result.current.startNlp(view.result.current.beginSubmission())).toBe(false),
    );
    act(() => useSettingsStore.setState({ aiSearchEnabled: true }));
    act(() => useSearchStore.setState({ query: "abc" }));
    view.rerender({ ...props, query: "abc" });
    act(() =>
      expect(view.result.current.startNlp(view.result.current.beginSubmission())).toBe(false),
    );
    act(() => useSearchStore.setState({ query: props.query }));
    view.rerender({
      ...props,
      captureViewport: () => ({ ...viewport, mapCenter: null }),
    });
    act(() =>
      expect(view.result.current.startNlp(view.result.current.beginSubmission())).toBe(false),
    );
  });

  it("keeps ownership separate across map and viewer surfaces", () => {
    const map = renderHook(() => useSearchSubmission(options("map")));
    const viewer = renderHook(() => useSearchSubmission(options("street-level")));
    act(() => {
      expect(map.result.current.startNlp(map.result.current.beginSubmission())).toBe(true);
      expect(viewer.result.current.startNlp(viewer.result.current.beginSubmission())).toBe(false);
    });
    act(() =>
      useStreetLevelStore.setState({ activeImage: { providerId: "synthetic", imageId: "1" } }),
    );
    act(() =>
      expect(viewer.result.current.startNlp(viewer.result.current.beginSubmission())).toBe(true),
    );
    expect(map.result.current.nlp.pending).toBe(false);
    expect(viewer.result.current.nlp.pending).toBe(true);
  });

  it("makes a retained active consent handler inert after teardown", () => {
    const view = renderHook(() => useSearchSubmission(options()));
    act(() => view.result.current.startNlp(view.result.current.beginSubmission()));
    const accept = view.result.current.nlp.acceptConsent;
    view.unmount();
    act(() => accept());
    expect(localStorage.getItem("openmapx.nlp.cloudConsent")).toBeNull();
  });

  it("clears deadlines and invalidates retained handlers on unmount", () => {
    const props = options();
    const view = renderHook(() => useSearchSubmission(props));
    let context!: ReturnType<typeof view.result.current.beginSubmission>;
    act(() => {
      context = view.result.current.beginSubmission();
      view.result.current.deferSubmission(context);
    });
    const retained = view.result.current;
    view.unmount();
    act(() => {
      retained.settlePending();
      retained.runSubmission(context);
      vi.advanceTimersByTime(3000);
      retained.nlp.acceptConsent();
    });
    expect(props.executeResolvedSubmit).not.toHaveBeenCalled();
    expect(localStorage.getItem("openmapx.nlp.cloudConsent")).toBeNull();
  });
});
