import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import { useSession } from "../auth/useSession";
import {
  type ParkedDraft,
  type ParkedLocation,
  type PersonalVehicle,
  readLocalParked,
  readLocalVehicles,
  type VehicleDraft,
  writeLocalParked,
  writeLocalVehicles,
} from "../vehicles";

export const GARAGE_QUERY_KEY = "garage";

/**
 * Which store the caller's garage lives in. `"local"` is a real identity, not
 * a missing one: it owns its own cache entry, so signing in or out refetches
 * from the right side instead of serving the previous identity's rows.
 */
export function useGarageIdentity(): string {
  const { data } = useSession();
  return data?.user?.id ?? "local";
}

function nowIso(): string {
  return new Date().toISOString();
}

export function useVehicles() {
  const identity = useGarageIdentity();
  return useQuery({
    queryKey: [GARAGE_QUERY_KEY, "vehicles", identity],
    queryFn: () =>
      identity === "local"
        ? Promise.resolve(readLocalVehicles())
        : apiClient
            .get<{ vehicles: PersonalVehicle[] }>(API_ENDPOINTS.vehicles)
            .then((r) => r.vehicles),
    staleTime: 60_000,
  });
}

/** The flagged default, or the sole vehicle when nothing is flagged. */
export function useDefaultVehicle(): PersonalVehicle | null {
  const { data } = useVehicles();
  if (!data || data.length === 0) return null;
  return data.find((v) => v.isDefault) ?? (data.length === 1 ? data[0] : null);
}

export function useParkedLocations() {
  const identity = useGarageIdentity();
  return useQuery({
    queryKey: [GARAGE_QUERY_KEY, "parked", identity],
    queryFn: () =>
      identity === "local"
        ? Promise.resolve(readLocalParked())
        : apiClient.get<{ parked: ParkedLocation[] }>(API_ENDPOINTS.parking).then((r) => r.parked),
    staleTime: 30_000,
  });
}

function useInvalidateGarage() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [GARAGE_QUERY_KEY] });
}

export function useCreateVehicle() {
  const identity = useGarageIdentity();
  const invalidate = useInvalidateGarage();
  return useMutation({
    mutationFn: async (draft: VehicleDraft) => {
      if (identity !== "local") {
        return apiClient.post<PersonalVehicle>(API_ENDPOINTS.vehicles, draft);
      }
      const existing = readLocalVehicles();
      const created: PersonalVehicle = {
        id: crypto.randomUUID(),
        ...draft,
        isDefault: draft.isDefault || existing.length === 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const others = created.isDefault
        ? existing.map((v) => ({ ...v, isDefault: false }))
        : existing;
      writeLocalVehicles([...others, created]);
      return created;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateVehicle() {
  const identity = useGarageIdentity();
  const invalidate = useInvalidateGarage();
  return useMutation({
    mutationFn: async ({ id, ...patch }: Partial<VehicleDraft> & { id: string }) => {
      if (identity !== "local") {
        return apiClient.patch<{ ok: true }>(`${API_ENDPOINTS.vehicles}/${id}`, patch);
      }
      const rows = readLocalVehicles().map((vehicle) =>
        vehicle.id === id ? { ...vehicle, ...patch, updatedAt: nowIso() } : vehicle,
      );
      const promoted = patch.isDefault
        ? rows.map((v) => (v.id === id ? v : { ...v, isDefault: false }))
        : rows;
      writeLocalVehicles(promoted);
      return { ok: true } as const;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteVehicle() {
  const identity = useGarageIdentity();
  const invalidate = useInvalidateGarage();
  return useMutation({
    mutationFn: async (id: string) => {
      if (identity !== "local") {
        return apiClient.delete<{ ok: true }>(`${API_ENDPOINTS.vehicles}/${id}`);
      }
      const remaining = readLocalVehicles().filter((vehicle) => vehicle.id !== id);
      // A garage with no default silently deselects the user's car; promote the
      // oldest survivor, mirroring the server.
      if (remaining.length > 0 && !remaining.some((v) => v.isDefault)) {
        remaining[0] = { ...remaining[0], isDefault: true };
      }
      writeLocalVehicles(remaining);
      // The server cascades; locally the same rule has to be applied by hand.
      writeLocalParked(readLocalParked().filter((record) => record.vehicleId !== id));
      return { ok: true } as const;
    },
    onSuccess: invalidate,
  });
}

export function useSaveParkedLocation() {
  const identity = useGarageIdentity();
  const invalidate = useInvalidateGarage();
  return useMutation({
    mutationFn: async (draft: ParkedDraft) => {
      if (identity !== "local") {
        return apiClient.put<ParkedLocation>(API_ENDPOINTS.parking, draft);
      }
      const at = nowIso();
      const saved: ParkedLocation = {
        id: crypto.randomUUID(),
        ...draft,
        savedAt: at,
        updatedAt: at,
      };
      // writeLocalParked keeps the newest record per vehicle, which is the
      // local equivalent of the server's NULLS NOT DISTINCT constraint.
      writeLocalParked([...readLocalParked(), saved]);
      return saved;
    },
    onSuccess: invalidate,
  });
}

export function useUpdateParkedLocation() {
  const identity = useGarageIdentity();
  const invalidate = useInvalidateGarage();
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: { id: string } & Partial<
      Pick<ParkedLocation, "lat" | "lng" | "address" | "note" | "expiresAt">
    >) => {
      if (identity !== "local") {
        return apiClient.patch<{ ok: true }>(`${API_ENDPOINTS.parking}/${id}`, patch);
      }
      writeLocalParked(
        readLocalParked().map((record) =>
          record.id === id ? { ...record, ...patch, updatedAt: nowIso() } : record,
        ),
      );
      return { ok: true } as const;
    },
    onSuccess: invalidate,
  });
}

export function useClearParkedLocation() {
  const identity = useGarageIdentity();
  const invalidate = useInvalidateGarage();
  return useMutation({
    mutationFn: async (id: string) => {
      if (identity !== "local") {
        return apiClient.delete<{ ok: true }>(`${API_ENDPOINTS.parking}/${id}`);
      }
      writeLocalParked(readLocalParked().filter((record) => record.id !== id));
      return { ok: true } as const;
    },
    onSuccess: invalidate,
  });
}
