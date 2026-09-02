"use client";

import type { LngLat, ParkedSource } from "@openmapx/core";
import { useDefaultVehicle, useSaveParkedLocation } from "@openmapx/core";
import { useCallback } from "react";
import { useForegroundLocation } from "@/lib/mobile/useForegroundLocation";

export type SaveParkingResult = "saved" | "unavailable" | "failed";

interface SaveAtOptions {
  address?: string | null;
  source?: ParkedSource;
  accuracyMeters?: number | null;
}

/**
 * The one way parking is written. Every entry point goes through here so a
 * saved position always carries the same vehicle assignment, the same source
 * labelling, and the same failure vocabulary.
 *
 * `saveHere` takes a fresh fix rather than reading the last published user
 * location: the marker in the store can be minutes old, and a pin that points
 * at where the user was when the map last updated is worse than no pin.
 */
export function useSaveParking() {
  const save = useSaveParkedLocation();
  const defaultVehicle = useDefaultVehicle();
  const requestFix = useForegroundLocation();
  const saveAsync = save.mutateAsync;
  const defaultVehicleId = defaultVehicle?.id ?? null;

  const saveAt = useCallback(
    async (coords: LngLat, options: SaveAtOptions): Promise<SaveParkingResult> => {
      const [lng, lat] = coords;
      try {
        await saveAsync({
          vehicleId: defaultVehicleId,
          lat,
          lng,
          address: options.address ?? null,
          note: null,
          expiresAt: null,
          source: options.source ?? "manual",
          accuracyMeters: options.accuracyMeters ?? null,
        });
        return "saved";
      } catch {
        return "failed";
      }
    },
    [saveAsync, defaultVehicleId],
  );

  const saveHere = useCallback(
    async (options: { source?: ParkedSource } = {}): Promise<SaveParkingResult> => {
      const result = await requestFix();
      if (result.status !== "ok") return "unavailable";
      return saveAt([result.fix.lng, result.fix.lat], {
        source: options.source ?? "device",
        accuracyMeters: result.fix.accuracy ?? null,
      });
    },
    [requestFix, saveAt],
  );

  return { saveAt, saveHere, isSaving: save.isPending };
}
