"use client";

import {
  API_ENDPOINTS,
  apiClient,
  clearLocalGarage,
  GARAGE_QUERY_KEY,
  hasImportedGarageFor,
  markGarageImported,
  type PersonalVehicle,
  takeLocalGarage,
  useSession,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

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
  const running = useRef(false);

  useEffect(() => {
    if (!userId || running.current) return;
    if (hasImportedGarageFor(userId)) return;

    const local = takeLocalGarage();
    if (local.vehicles.length === 0 && local.parked.length === 0) {
      markGarageImported(userId);
      return;
    }

    running.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const remote = await apiClient.get<{ vehicles: PersonalVehicle[] }>(API_ENDPOINTS.vehicles);
        const taken = new Set(remote.vehicles.map((v) => v.name.trim().toLowerCase()));

        for (const vehicle of local.vehicles) {
          if (taken.has(vehicle.name.trim().toLowerCase())) continue;
          const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = vehicle;
          await apiClient.post(API_ENDPOINTS.vehicles, draft);
        }

        for (const record of local.parked) {
          const { id: _id, savedAt: _savedAt, updatedAt: _updatedAt, ...draft } = record;
          // Locally-created vehicle ids do not exist on the server, so the
          // record is imported unassigned rather than rejected as a 404.
          await apiClient.put(API_ENDPOINTS.parking, { ...draft, vehicleId: null });
        }

        if (cancelled) return;
        clearLocalGarage();
        markGarageImported(userId);
        await queryClient.invalidateQueries({ queryKey: [GARAGE_QUERY_KEY] });
      } catch {
        // Leave the local rows and the marker alone; the next mount retries.
      } finally {
        running.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, queryClient]);

  return null;
}
