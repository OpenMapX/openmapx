"use client";

import {
  API_ENDPOINTS,
  apiClient,
  clearLocalGarage,
  GARAGE_QUERY_KEY,
  hasImportedGarageFor,
  markGarageImported,
  type ParkedLocation,
  type PersonalVehicle,
  takeLocalGarage,
  useSession,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * Moves a signed-out user's garage onto their account the first time they sign
 * in, then gets out of the way.
 *
 * Server rows always win: a name collision keeps the account's vehicle and
 * drops the local one, so signing in on a second device cannot silently
 * replace the car the user already described. Any failure leaves both the local
 * rows and the "imported" marker untouched, so the next mount tries again
 * rather than losing data to a dropped connection.
 */
export function GarageSyncBridge() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!userId) return;
    if (hasImportedGarageFor(userId)) return;

    const local = takeLocalGarage();
    if (local.vehicles.length === 0 && local.parked.length === 0) {
      markGarageImported(userId);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const remote = await apiClient.get<{ vehicles: PersonalVehicle[] }>(API_ENDPOINTS.vehicles);
        if (cancelled) return;
        const parking = await apiClient.get<{ parked: ParkedLocation[] }>(API_ENDPOINTS.parking);
        if (cancelled) return;
        const byName = new Map(remote.vehicles.map((v) => [v.name.trim().toLowerCase(), v.id]));
        const vehicleIds = new Map<string, string>();
        const parkedIds = new Set(parking.parked.map((p) => p.vehicleId));

        for (const vehicle of local.vehicles) {
          if (cancelled) return;
          const name = vehicle.name.trim().toLowerCase();
          const existingId = byName.get(name);
          if (existingId) {
            vehicleIds.set(vehicle.id, existingId);
            continue;
          }
          const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = vehicle;
          const created = await apiClient.post<{ id: string }>(API_ENDPOINTS.vehicles, draft);
          if (!created.id) throw new Error("Imported vehicle has no account ID");
          byName.set(name, created.id);
          vehicleIds.set(vehicle.id, created.id);
        }

        for (const record of local.parked) {
          const { id: _id, savedAt: _savedAt, updatedAt: _updatedAt, ...draft } = record;
          if (cancelled) return;
          const vehicleId = record.vehicleId === null ? null : vehicleIds.get(record.vehicleId);
          if (vehicleId === undefined) throw new Error("Parking vehicle was not imported");
          // Account pins also win on retries after a partially completed import.
          if (parkedIds.has(vehicleId)) continue;
          await apiClient.put(API_ENDPOINTS.parking, { ...draft, vehicleId });
          parkedIds.add(vehicleId);
        }

        if (cancelled || JSON.stringify(takeLocalGarage()) !== JSON.stringify(local)) return;
        clearLocalGarage();
        markGarageImported(userId);
        await queryClient.invalidateQueries({ queryKey: [GARAGE_QUERY_KEY] });
      } catch {
        // Leave the local rows and the marker alone; the next mount retries.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, queryClient]);

  return null;
}
