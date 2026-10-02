"use client";

import { type Place, usePlaceStore } from "@openmapx/core";
import { useCallback, useEffect, useRef } from "react";

/** Select immediately; asynchronous data can improve only that selection. */
export function usePlaceEnrichment() {
  const pending = useRef<{ continueOnUnmount: boolean } | null>(null);
  const cancelEnrichment = useCallback(() => {
    pending.current = null;
  }, []);
  useEffect(
    () => () => {
      if (!pending.current?.continueOnUnmount) cancelEnrichment();
    },
    [cancelEnrichment],
  );

  const selectWithEnrichment = useCallback(
    (
      provisional: Place,
      resolve: (isCurrent: () => boolean) => Promise<Place | null>,
      options?: { continueOnUnmount?: boolean },
    ) => {
      const owner = { continueOnUnmount: options?.continueOnUnmount ?? false };
      pending.current = owner;
      usePlaceStore.getState().setSelectedPlace(provisional);
      const revision = usePlaceStore.getState().selectionRevision;
      const isCurrent = () =>
        pending.current === owner &&
        usePlaceStore.getState().selectionRevision === revision &&
        usePlaceStore.getState().selectedPlace !== null;
      void (async () => {
        try {
          const enriched = await resolve(isCurrent);
          if (enriched && isCurrent())
            usePlaceStore.getState().enrichSelectedPlace(revision, enriched);
        } catch {
          // Keep the useful provisional place when enrichment is unavailable.
        } finally {
          if (pending.current === owner) pending.current = null;
        }
      })();
    },
    [],
  );

  return { selectWithEnrichment, cancelEnrichment };
}
