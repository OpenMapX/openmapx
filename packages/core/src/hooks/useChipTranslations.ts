import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import type { ChipTranslation } from "../services/presets/chip-translations";

interface ChipTranslationsResponse {
  translations: Record<string, ChipTranslation>;
}

/** 1 hour. Chip translations only change when the iD preset package is upgraded. */
const CHIP_TRANSLATIONS_STALE_MS = 60 * 60 * 1_000;

/**
 * Per-locale localized names + search terms for chip-bar categories whose tag-set
 * has an exact iD-preset equivalent (e.g. `fuel` → "Tankstelle"/"tanke" in DE).
 * Multi-tag chips (e.g. `restaurants`) are absent from the result.
 *
 * The `select` projection returns the inner `translations` record directly so
 * consumers can use `data` as a `useMemo` dependency without unwrapping. Combined
 * with TanStack Query's default structural sharing, the reference stays stable
 * across refetches that produce structurally-equal payloads.
 */
export function useChipTranslations(lang?: string) {
  return useQuery({
    queryKey: ["chip-translations", lang ?? "en"],
    queryFn: () =>
      apiClient.get<ChipTranslationsResponse>(API_ENDPOINTS.chipTranslations, {
        ...(lang && { lang }),
      }),
    select: (resp) => resp.translations,
    staleTime: CHIP_TRANSLATIONS_STALE_MS,
  });
}
