import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient, configureApiClient } from "../api/client";
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

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

beforeEach(() => {
  storage = memoryStorage();
  configureStorage(storage);
  session.value = null;
  configureApiClient({ baseUrl: "http://garage.test", credentials: "include" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, _init?: unknown) => json({ vehicles: [] })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    const get = vi.mocked(fetch).mockImplementation(async () => json({ vehicles: [serverRow] }));

    const { result } = renderHook(() => useVehicles(), { wrapper: wrapper(client()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].name).toBe("Server Car");
    expect(get).toHaveBeenCalledWith(
      "http://garage.test/api/vehicles",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("caches the two identities separately", async () => {
    storage.map.set(LOCAL_VEHICLES_KEY, JSON.stringify([LOCAL_ROW]));
    vi.mocked(fetch).mockImplementation(async () =>
      json({ vehicles: [{ ...LOCAL_ROW, id: "v-server", name: "Server Car" }] }),
    );
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
    const put = vi
      .mocked(fetch)
      .mockImplementation(async () =>
        json({ ...DRAFT, id: "p1", savedAt: LOCAL_ROW.createdAt, updatedAt: LOCAL_ROW.updatedAt }),
      );

    const { result } = renderHook(() => useSaveParkedLocation(), { wrapper: wrapper(client()) });
    await result.current.mutateAsync(DRAFT);

    expect(put).toHaveBeenCalledWith(
      "http://garage.test/api/parking",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(DRAFT) }),
    );
    expect(storage.map.get("openmapx:garage:parked")).toBeUndefined();
  });
});

it("rejects a malformed remote vehicle instead of publishing it into the account cache", async () => {
  session.value = { user: { id: "user-1" } };
  vi.mocked(fetch).mockImplementation(async () =>
    json({ vehicles: [{ ...LOCAL_ROW, kind: "hovercraft" }] }),
  );
  const { result } = renderHook(() => useVehicles(), { wrapper: wrapper(client()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
});

it("refuses a vehicle response whose confidentiality metadata is missing", async () => {
  session.value = { user: { id: "user-1" } };
  vi.mocked(fetch).mockImplementation(
    async () =>
      new Response(JSON.stringify({ vehicles: [LOCAL_ROW] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  const { result } = renderHook(() => useVehicles(), { wrapper: wrapper(client()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data).toBeUndefined();
});

it("cancels the prior account acquisition when the identity changes", async () => {
  session.value = { user: { id: "user-1" } };
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.mocked(fetch)
    .mockImplementationOnce(async () => pending)
    .mockImplementation(async () => json({ vehicles: [{ ...LOCAL_ROW, id: "account-two" }] }));
  const shared = client();
  const view = renderHook(() => useVehicles(), { wrapper: wrapper(shared) });
  try {
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const options = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    session.value = { user: { id: "user-2" } };
    view.rerender();
    await waitFor(() => expect(view.result.current.data?.[0].id).toBe("account-two"));
    expect(options.signal?.aborted).toBe(true);
    release(json({ vehicles: [{ ...LOCAL_ROW, id: "retired-account" }] }));
    await waitFor(() =>
      expect(shared.getQueryData(["garage", "vehicles", "user-1"])).toBeUndefined(),
    );
    expect(view.result.current.data?.[0].id).toBe("account-two");
  } finally {
    release(json({ vehicles: [] }));
    view.unmount();
    shared.clear();
  }
});
