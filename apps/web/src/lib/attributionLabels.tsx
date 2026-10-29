"use client";
import type { AttributionLabels } from "@openmapx/core/attribution";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { create } from "zustand";

/**
 * The viewer's wording for what credit presentations add to a receipt's own.
 * A store rather than a translation hook, so map credit trackers and hooks
 * outside any translated tree read the same words; untranslated, English.
 */
export const useAttributionLabelStore = create<{ labels: AttributionLabels }>(() => ({
  labels: { modified: "data modified" },
}));

export function useAttributionLabels(): AttributionLabels {
  return useAttributionLabelStore((state) => state.labels);
}

/** Keeps the store in the viewer's language; mounted once inside the translations. */
export function AttributionLabelsSync(): null {
  const t = useTranslations("common");
  const modified = t("dataModified");
  useEffect(() => {
    if (useAttributionLabelStore.getState().labels.modified !== modified)
      useAttributionLabelStore.setState({ labels: { modified } });
  }, [modified]);
  return null;
}
