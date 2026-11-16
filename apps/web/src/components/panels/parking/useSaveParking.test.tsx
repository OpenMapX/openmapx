import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook as renderBareHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  save: vi.fn(async () => ({ id: "p1" })),
  defaultVehicle: null as { id: string } | null,
  fix: { status: "ok", fix: { lat: 51.55, lng: 6.6, accuracy: 8 } } as unknown,
  update: vi.fn(async () => ({})),
  reverse: vi.fn(async () => ({ address: "Unter den Linden 37" }) as { address: string } | null),
}));

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSaveParkedLocation: () => ({ mutateAsync: state.save, isPending: false }),
  useDefaultVehicle: () => state.defaultVehicle,
  useUpdateParkedLocation: () => ({ mutateAsync: state.update }),
  apiClient: { get: state.reverse },
}));

vi.mock("next-intl", () => ({ useLocale: () => "en" }));

function renderHook<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderBareHook(hook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

vi.mock("@/lib/mobile/useForegroundLocation", () => ({
  useForegroundLocation: () => async () => state.fix,
}));

import { useSaveParking } from "./useSaveParking";

beforeEach(() => {
  state.save.mockClear();
  state.update.mockClear();
  state.reverse.mockClear();
  state.defaultVehicle = null;
  state.fix = { status: "ok", fix: { lat: 51.55, lng: 6.6, accuracy: 8 } };
});

describe("useSaveParking", () => {
  it("saves an explicit coordinate as a manual save", async () => {
    const { result } = renderHook(() => useSaveParking());
    await expect(result.current.saveAt([6.6, 51.55], { address: "Am Kuhteich 42" })).resolves.toBe(
      "saved",
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: 51.55,
        lng: 6.6,
        address: "Am Kuhteich 42",
        source: "manual",
        accuracyMeters: null,
      }),
    );
  });

  it("takes a fresh fix for saveHere and records its accuracy", async () => {
    const { result } = renderHook(() => useSaveParking());
    await expect(result.current.saveHere()).resolves.toBe("saved");
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({ source: "device", accuracyMeters: 8 }),
    );
  });

  it("assigns the default vehicle when there is one", async () => {
    state.defaultVehicle = { id: "v1" };
    const { result } = renderHook(() => useSaveParking());
    await result.current.saveAt([6.6, 51.55], {});
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ vehicleId: "v1" }));
  });

  it("reports an unavailable fix without calling the mutation", async () => {
    state.fix = { status: "denied" };
    const { result } = renderHook(() => useSaveParking());
    await expect(result.current.saveHere()).resolves.toBe("unavailable");
    expect(state.save).not.toHaveBeenCalled();
  });

  it("reports a failed write", async () => {
    state.save.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useSaveParking());
    await expect(result.current.saveAt([6.6, 51.55], {})).resolves.toBe("failed");
  });

  it("allows an arrival save to be labelled as such", async () => {
    const { result } = renderHook(() => useSaveParking());
    await result.current.saveHere({ source: "arrival" });
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ source: "arrival" }));
  });

  it("stores the address of a spot saved without one, after saving", async () => {
    const { result } = renderHook(() => useSaveParking());
    await expect(result.current.saveHere()).resolves.toBe("saved");
    await waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({ id: "p1", address: "Unter den Linden 37" }),
    );
  });

  it("does not look up an address the save already carries", async () => {
    const { result } = renderHook(() => useSaveParking());
    await result.current.saveAt([6.6, 51.55], { address: "Am Kuhteich 42" });
    expect(state.reverse).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("keeps the spot when the lookup fails", async () => {
    state.reverse.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useSaveParking());
    await expect(result.current.saveHere()).resolves.toBe("saved");
    await waitFor(() => expect(state.reverse).toHaveBeenCalled());
    expect(state.update).not.toHaveBeenCalled();
  });
});
