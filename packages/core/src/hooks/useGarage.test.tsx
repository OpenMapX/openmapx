import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../api/client";
import { configureStorage, type StorageAdapter } from "../platform/storage";
import { LOCAL_VEHICLES_KEY } from "../vehicles";

const session = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
vi.mock("../auth/useSession", () => ({ useSession: () => ({ data: session.value }) }));

import { useDefaultVehicle, useSaveParkedLocation, useVehicles } from "./useGarage";

function memoryStorage(): StorageAdapter & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getString: (k) => map.get(k) ?? null,
    setString: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

let storage: ReturnType<typeof memoryStorage>;

const LOCAL_ROW = {
  id: "v-local",
  name: "Local Car",
  kind: "car",
  powertrain: "petrol",
  isDefault: true,
  presetId: null,
  ev: null,
  fuelConsumptionLPer100Km: 6,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

beforeEach(() => {
  storage = memoryStorage();
  configureStorage(storage);
  session.value = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useVehicles", () => {
  it("reads the local store when signed out and never calls the API", async () => {
    storage.map.set(LOCAL_VEHICLES_KEY, JSON.stringify([LOCAL_ROW]));
    const get = vi.spyOn(apiClient, "get");

    const { result } = renderHook(() => useVehicles(), { wrapper: wrapper(client()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].name).toBe("Local Car");
    expect(get).not.toHaveBeenCalled();
  });

  it("reads the API when signed in", async () => {
    session.value = { user: { id: "user-1" } };
    const serverRow = { ...LOCAL_ROW, id: "v-server", name: "Server Car" };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ vehicles: [serverRow] } as never);

    const { result } = renderHook(() => useVehicles(), { wrapper: wrapper(client()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].name).toBe("Server Car");
    expect(get).toHaveBeenCalledWith("/api/vehicles");
  });

  it("caches the two identities separately", async () => {
    storage.map.set(LOCAL_VEHICLES_KEY, JSON.stringify([LOCAL_ROW]));
    vi.spyOn(apiClient, "get").mockResolvedValue({
      vehicles: [{ ...LOCAL_ROW, id: "v-server", name: "Server Car" }],
    } as never);
    const shared = client();

    const anonymous = renderHook(() => useVehicles(), { wrapper: wrapper(shared) });
    await waitFor(() => expect(anonymous.result.current.data?.[0].name).toBe("Local Car"));

    session.value = { user: { id: "user-1" } };
    const signedIn = renderHook(() => useVehicles(), { wrapper: wrapper(shared) });
    await waitFor(() => expect(signedIn.result.current.data?.[0].name).toBe("Server Car"));
  });
});

describe("useDefaultVehicle", () => {
  it("returns the default, or the only vehicle when none is flagged", async () => {
    storage.map.set(
      LOCAL_VEHICLES_KEY,
      JSON.stringify([{ ...LOCAL_ROW, isDefault: false, name: "Only" }]),
    );
    const { result } = renderHook(() => useDefaultVehicle(), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current?.name).toBe("Only"));
  });

  it("returns null with an empty garage", async () => {
    const { result } = renderHook(() => useDefaultVehicle(), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current).toBeNull());
  });
});

describe("useSaveParkedLocation", () => {
  const DRAFT = {
    vehicleId: null,
    lat: 51.55,
    lng: 6.6,
    address: null,
    note: null,
    expiresAt: null,
    source: "manual" as const,
    accuracyMeters: null,
  };

  it("writes to local storage when signed out", async () => {
    const { result } = renderHook(() => useSaveParkedLocation(), { wrapper: wrapper(client()) });

    await result.current.mutateAsync(DRAFT);

    const stored = JSON.parse(storage.map.get("openmapx:garage:parked") ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].lat).toBe(51.55);
  });

  it("PUTs to the API when signed in", async () => {
    session.value = { user: { id: "user-1" } };
    const put = vi.spyOn(apiClient, "put").mockResolvedValue({ id: "p1" } as never);

    const { result } = renderHook(() => useSaveParkedLocation(), { wrapper: wrapper(client()) });
    await result.current.mutateAsync(DRAFT);

    expect(put).toHaveBeenCalledWith("/api/parking", expect.objectContaining({ lat: 51.55 }));
    expect(storage.map.get("openmapx:garage:parked")).toBeUndefined();
  });
});
