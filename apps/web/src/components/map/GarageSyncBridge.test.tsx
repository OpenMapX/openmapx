import { apiClient, configureStorage, type StorageAdapter } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@/test";

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
    vi.spyOn(apiClient, "get").mockResolvedValue({ vehicles: [], parked: [] } as never);

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
    vi.spyOn(apiClient, "get").mockResolvedValue({ vehicles: [], parked: [] } as never);

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
      parked: [],
    } as never);

    render(<GarageSyncBridge />, { wrapper });

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(post).not.toHaveBeenCalled();
  });
});

describe("garage import parking ownership", () => {
  it("preserves two vehicle-specific pins under their new account IDs", async () => {
    session.value = { user: { id: "user-1" } };
    storage.map.set(
      "openmapx:garage:vehicles",
      JSON.stringify([
        LOCAL_VEHICLE,
        { ...LOCAL_VEHICLE, id: "v-other", name: "Other", isDefault: false },
      ]),
    );
    storage.map.set(
      "openmapx:garage:parked",
      JSON.stringify([
        { ...LOCAL_PARKED, vehicleId: "v-local" },
        { ...LOCAL_PARKED, id: "p-other", vehicleId: "v-other", lat: 50 },
      ]),
    );
    vi.spyOn(apiClient, "get").mockResolvedValue({ vehicles: [], parked: [] });
    let created = 0;
    vi.spyOn(apiClient, "post").mockImplementation(async () => ({ id: `server-${++created}` }));
    const put = vi.spyOn(apiClient, "put").mockResolvedValue({ id: "pin" });
    render(<GarageSyncBridge />, { wrapper });
    await waitFor(() => expect(storage.map.get("openmapx:garage:importedFor")).toContain("user-1"));
    expect(
      put.mock.calls.map((call) => (call[1] as { vehicleId: string | null }).vehicleId),
    ).toEqual(["server-1", "server-2"]);
  });

  it("maps a retry to the existing vehicle and keeps the account parking pin", async () => {
    session.value = { user: { id: "user-1" } };
    storage.map.set(
      "openmapx:garage:parked",
      JSON.stringify([{ ...LOCAL_PARKED, vehicleId: "v-local" }]),
    );
    vi.spyOn(apiClient, "get").mockResolvedValue({
      vehicles: [{ ...LOCAL_VEHICLE, id: "server", name: "local car" }],
      parked: [{ ...LOCAL_PARKED, id: "remote-pin", vehicleId: "server", lat: 49 }],
    });
    const post = vi.spyOn(apiClient, "post");
    const put = vi.spyOn(apiClient, "put").mockResolvedValue({ id: "pin" });
    render(<GarageSyncBridge />, { wrapper });
    await waitFor(() => expect(storage.map.get("openmapx:garage:importedFor")).toContain("user-1"));
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("does not continue writes after an account switch during the read", async () => {
    session.value = { user: { id: "user-1" } };
    let resolveRead: (value: unknown) => void = () => {};
    vi.spyOn(apiClient, "get").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ id: "server" });
    const put = vi.spyOn(apiClient, "put").mockResolvedValue({ id: "pin" });
    const view = render(<GarageSyncBridge />, { wrapper });
    session.value = null;
    view.rerender(<GarageSyncBridge />);
    await act(async () => resolveRead({ vehicles: [], parked: [] }));
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(storage.map.get("openmapx:garage:vehicles")).toBeTruthy();
  });
});
