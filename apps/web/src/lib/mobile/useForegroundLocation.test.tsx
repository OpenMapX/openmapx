import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  value: {
    browserAuthority: false,
    state: "native-compatible",
    client: {},
    readModel: { revision: 1 },
    handshake: null,
  } as Record<string, unknown>,
}));

vi.mock("./MobileRuntimeProvider", () => ({
  useMobileRuntimeContext: () => runtime.value,
}));

const { useForegroundLocation } = await import("./useForegroundLocation");

describe("useForegroundLocation", () => {
  it("keeps one function while native snapshots arrive", () => {
    // The map is built from this function: a new one on every snapshot tore the
    // map down and rebuilt it every few seconds during native navigation.
    const view = renderHook(() => useForegroundLocation());
    const first = view.result.current;

    runtime.value = { ...runtime.value, readModel: { revision: 2 } };
    view.rerender();

    expect(view.result.current).toBe(first);
  });

  it("changes when where it would ask for a fix changes", () => {
    const view = renderHook(() => useForegroundLocation());
    const first = view.result.current;

    runtime.value = { ...runtime.value, browserAuthority: true, state: "browser" };
    view.rerender();

    expect(view.result.current).not.toBe(first);
  });
});
