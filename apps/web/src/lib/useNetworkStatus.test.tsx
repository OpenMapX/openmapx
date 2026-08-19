import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNetworkStatus } from "./useNetworkStatus";

describe("useNetworkStatus", () => {
  const originalConnection = Object.getOwnPropertyDescriptor(navigator, "connection");
  const originalOnline = Object.getOwnPropertyDescriptor(navigator, "onLine");

  afterEach(() => {
    if (originalConnection) Object.defineProperty(navigator, "connection", originalConnection);
    else Reflect.deleteProperty(navigator, "connection");
    if (originalOnline) Object.defineProperty(navigator, "onLine", originalOnline);
    vi.restoreAllMocks();
  });

  it("publishes connection and reachability changes and unsubscribes on unmount", () => {
    let connectionListener: (() => void) | undefined;
    const connection = {
      effectiveType: "4g",
      saveData: false,
      type: "wifi",
      addEventListener: vi.fn((...args: unknown[]) => {
        connectionListener = args[1] as () => void;
      }),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    const status = renderHook(() => useNetworkStatus());
    expect(status.result.current).toMatchObject({
      online: true,
      supported: true,
      effectiveType: "4g",
      connectionType: "wifi",
      metered: false,
    });

    connection.effectiveType = "2g";
    act(() => connectionListener?.());
    expect(status.result.current).toMatchObject({ effectiveType: "2g", metered: true });

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event("offline")));
    expect(status.result.current.online).toBe(false);

    status.unmount();
    expect(connection.removeEventListener).toHaveBeenCalledWith("change", connectionListener);
  });
});
