"use client";

import type { LngLat, ParkedSource, ReverseGeocodingResult } from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  CALLER_SHOWS_ERRORS,
  useDefaultVehicle,
  useSaveParkedLocation,
  useUpdateParkedLocation,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale } from "next-intl";
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
/**
 * Stores the address of a parked spot that was saved or moved without one.
 * The address is kept with the spot rather than looked up whenever it is shown:
 * you look for the car later, often offline, and one lookup per spot sends its
 * coordinates to the geocoder once instead of on every view. The spot is saved
 * first and never waits on this; a failed lookup leaves it without an address,
 * and the panel then looks it up for display.
 */
export function useParkingAddressBackfill() {
  const queryClient = useQueryClient();
  const locale = useLocale();
  const update = useUpdateParkedLocation(CALLER_SHOWS_ERRORS);
  const updateAsync = update.mutateAsync;
  return useCallback(
    async (id: string, [lng, lat]: LngLat): Promise<void> => {
      try {
        // Shares the map's reverse-geocode cache (useReverseGeocoding's key).
        const result = await queryClient.fetchQuery({
          queryKey: ["reverse-geocode", lng, lat, locale],
          queryFn: () =>
            apiClient.get<ReverseGeocodingResult | null>(API_ENDPOINTS.geocodeReverse, {
              lat: String(lat),
              lng: String(lng),
              lang: locale,
            }),
          staleTime: 60_000,
        });
        if (result?.address) await updateAsync({ id, address: result.address });
      } catch {
        // The spot stays saved without an address.
      }
    },
    [queryClient, locale, updateAsync],
  );
}

export function useSaveParking() {
  const save = useSaveParkedLocation(CALLER_SHOWS_ERRORS);
  const defaultVehicle = useDefaultVehicle();
  const requestFix = useForegroundLocation();
  const saveAsync = save.mutateAsync;
  const backfillAddress = useParkingAddressBackfill();
  const defaultVehicleId = defaultVehicle?.id ?? null;

  const saveAt = useCallback(
    async (coords: LngLat, options: SaveAtOptions): Promise<SaveParkingResult> => {
      const [lng, lat] = coords;
      try {
        const saved = await saveAsync({
          vehicleId: defaultVehicleId,
          lat,
          lng,
          address: options.address ?? null,
          note: null,
          expiresAt: null,
          source: options.source ?? "manual",
          accuracyMeters: options.accuracyMeters ?? null,
        });
        if (!options.address && saved?.id) void backfillAddress(saved.id, coords);
        return "saved";
      } catch {
        return "failed";
      }
    },
    [saveAsync, defaultVehicleId, backfillAddress],
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
