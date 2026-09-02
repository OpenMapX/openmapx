import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  save: vi.fn(async () => ({ id: "p1" })),
  defaultVehicle: null as { id: string } | null,
  fix: { status: "ok", fix: { lat: 51.55, lng: 6.6, accuracy: 8 } } as unknown,
}));

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSaveParkedLocation: () => ({ mutateAsync: state.save, isPending: false }),
  useDefaultVehicle: () => state.defaultVehicle,
}));

vi.mock("@/lib/mobile/useForegroundLocation", () => ({
  useForegroundLocation: () => async () => state.fix,
}));

import { useSaveParking } from "./useSaveParking";

beforeEach(() => {
  state.save.mockClear();
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

  it("reports no write in flight once settled", async () => {
    const { result } = renderHook(() => useSaveParking());
    await waitFor(() => expect(result.current.isSaving).toBe(false));
  });
});
