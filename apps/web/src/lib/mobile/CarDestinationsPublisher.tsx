"use client";
import {
  useCarSavedPlaces,
  useDirectionsStore,
  useNavigationStore,
  useSession,
  useSettingsStore,
} from "@openmapx/core";
import { carDestinationSchema, carDestinationsSchema } from "@openmapx/core/navigation";
import { useLocale } from "next-intl";
import { useEffect, useRef } from "react";
import { scopeRecentDestinations, useRecentSearchStore } from "@/stores/recentSearchStore";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";

/** Publishes only coordinate-bearing saved data, never cookies or account credentials. */
export function CarDestinationsPublisher() {
  const delivered = useRef<{ client: unknown; json: string } | null>(null);
  const runtime = useMobileRuntimeContext();
  const { data: session, isPending } = useSession();
  const { data: labels } = useCarSavedPlaces(
    runtime.state === "native-compatible" && !!runtime.handshake?.capabilities.carDestinations,
  );
  const recent = useRecentSearchStore((s) => s.destinations);
  const locale = useLocale();
  const settings = useSettingsStore();
  const directions = useDirectionsStore();
  const navigation = useNavigationStore();
  useEffect(() => {
    if (isPending) return;
    const account = session?.user?.id ?? null;
    const scopedRecent = scopeRecentDestinations(account);
    if (
      isPending ||
      runtime.state !== "native-compatible" ||
      !runtime.handshake?.capabilities.carDestinations
    )
      return;
    const saved = account
      ? (labels ?? [])
          .flatMap((place) => {
            const parsed = carDestinationSchema.safeParse({
              id: place.id,
              label: place.name.slice(0, 160),
              coordinates: [place.lng, place.lat],
            });
            return parsed.success ? [parsed.data] : [];
          })
          .slice(0, 50)
      : [];
    const payload = carDestinationsSchema.parse({
      account,
      saved,
      recent: scopedRecent === recent ? recent : [],
      locale: locale === "de" ? "de" : "en",
      units: settings.units,
      avoidHighways: directions.avoidHighways,
      avoidTolls: directions.avoidTolls,
      avoidFerries: directions.avoidFerries,
      avoidClosures: settings.avoidIncidents,
      voiceEnabled: navigation.voiceEnabled,
      keepScreenOn: navigation.keepScreenOn,
      voiceTiming: settings.voiceGuidanceTiming,
    });
    const json = JSON.stringify(payload);
    if (delivered.current?.client === runtime.client && delivered.current.json === json) return;
    runtime.client?.send("destinations.update", payload);
    delivered.current = { client: runtime.client, json };
  }, [runtime, session, isPending, labels, recent, locale, settings, directions, navigation]);
  return null;
}
