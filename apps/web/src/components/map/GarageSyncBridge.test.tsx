import { apiClient, configureStorage, type StorageAdapter } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@/test";

const session = vi.hoisted(() => ({ value: null as { user: { id: string } } | null }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSession: () => ({ data: session.value }),
}));

import { GarageSyncBridge } from "./GarageSyncBridge";

function memoryStorage(): StorageAdapter & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getString: (k) => map.get(k) ?? null,
    setString: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

const LOCAL_VEHICLE = {
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

const LOCAL_PARKED = {
  id: "p-local",
  vehicleId: null,
  lat: 51.55,
  lng: 6.6,
  address: null,
  note: null,
  expiresAt: null,
  source: "manual",
  accuracyMeters: null,
  savedAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

let storage: ReturnType<typeof memoryStorage>;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  storage = memoryStorage();
  configureStorage(storage);
  storage.map.set("openmapx:garage:vehicles", JSON.stringify([LOCAL_VEHICLE]));
  storage.map.set("openmapx:garage:parked", JSON.stringify([LOCAL_PARKED]));
  session.value = null;
});

afterEach(() => vi.restoreAllMocks());

describe("GarageSyncBridge", () => {
  it("does nothing while signed out", async () => {
    const post = vi.spyOn(apiClient, "post");
    render(<GarageSyncBridge />, { wrapper });
    await waitFor(() => expect(post).not.toHaveBeenCalled());
    expect(storage.map.get("openmapx:garage:vehicles")).toBeTruthy();
  });

  it("uploads local rows once, then clears them and records the user", async () => {
    session.value = { user: { id: "user-1" } };
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ id: "v-server" } as never);
    const put = vi.spyOn(apiClient, "put").mockResolvedValue({ id: "p-server" } as never);
    vi.spyOn(apiClient, "get").mockResolvedValue({ vehicles: [] } as never);

    const view = render(<GarageSyncBridge />, { wrapper });

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(storage.map.get("openmapx:garage:vehicles")).toBeUndefined());
    expect(storage.map.get("openmapx:garage:importedFor")).toContain("user-1");

    view.rerender(<GarageSyncBridge />);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("keeps the local rows when the upload fails, so the next mount retries", async () => {
    session.value = { user: { id: "user-1" } };
    vi.spyOn(apiClient, "post").mockRejectedValue(new Error("offline"));
    vi.spyOn(apiClient, "get").mockResolvedValue({ vehicles: [] } as never);

    render(<GarageSyncBridge />, { wrapper });

    await waitFor(() => expect(storage.map.get("openmapx:garage:vehicles")).toBeTruthy());
    expect(storage.map.get("openmapx:garage:importedFor")).toBeUndefined();
  });

  it("does not overwrite a server vehicle with the same name", async () => {
    session.value = { user: { id: "user-1" } };
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ id: "v" } as never);
    const put = vi.spyOn(apiClient, "put").mockResolvedValue({ id: "p" } as never);
    vi.spyOn(apiClient, "get").mockResolvedValue({
      vehicles: [{ ...LOCAL_VEHICLE, id: "v-server", name: "local car" }],
    } as never);

    render(<GarageSyncBridge />, { wrapper });

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(post).not.toHaveBeenCalled();
  });
});
