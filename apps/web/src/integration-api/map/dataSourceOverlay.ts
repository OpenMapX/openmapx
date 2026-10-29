"use client";

import type { BoundingBox, DataSourceResult, LngLat } from "@openmapx/core";
import {
  createPlace,
  PANEL,
  useDataSourceSearch,
  useDataSourceStore,
  useDataSources,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { isI18nToken, token } from "@openmapx/integration-framework/strings";
import { withContributors } from "@openmapx/mobility-core/contributors";
import { useTranslations } from "next-intl";
import { useMemo, useRef } from "react";
import { useDataSourceI18nResolver } from "@/components/panels/place/useDataSourceI18nResolver";
import { dataSourceRecordContributors } from "@/lib/attributionForProviders";
import { translateDataSourceLabel, translateDataSourceSummary } from "@/lib/dataSourceSummaryI18n";
import { buildGeoJson, buildTrackGeoJson } from "./dataSourceFeatures";

type DataSourceListing = NonNullable<ReturnType<typeof useDataSources>["data"]>["sources"][number];

/** Where a data source drawn inside an overlay stands for the current view. */
export type DataSourceOverlayState = "idle" | "loading" | "ready" | "error";

const NO_RESULTS: DataSourceResult[] = [];

/** The listing of a data source, or null while the list loads or when the server offers none. */
export function useDataSourceListing(sourceId: string): DataSourceListing | null {
  const { data } = useDataSources();
  return useMemo(() => data?.sources.find((s) => s.id === sourceId) ?? null, [data, sourceId]);
}

/**
 * One data source's results for an area, ready to draw inside an overlay: the
 * marker and track GeoJSON with each record's credits captured, and the state
 * of the request. While a new area loads, the previous area's markers stay up
 * so panning does not blank the layer. A null `bbox` draws nothing.
 */
export function useDataSourceOverlayRecords(sourceId: string, bbox: BoundingBox | null) {
  const listing = useDataSourceListing(sourceId);
  const registry = useIntegrationRegistry();
  const resolveToken = useDataSourceI18nResolver(sourceId);
  const t = useTranslations("dataSources");
  const enabled = bbox !== null && listing !== null;
  const search = useDataSourceSearch(enabled ? sourceId : null, enabled ? bbox : null, {});

  const captured = useRef(new WeakMap<DataSourceResult, DataSourceResult>());
  const lastResults = useRef<DataSourceResult[]>(NO_RESULTS);
  const results = useMemo(() => {
    if (!enabled) {
      lastResults.current = NO_RESULTS;
      return NO_RESULTS;
    }
    if (!search.data) return lastResults.current;
    const declared = registry.get(sourceId)?.dataSources ?? [];
    const next = search.data.map((record) => {
      const retained = captured.current.get(record);
      if (retained) return retained;
      const withCredits = withContributors(
        record,
        dataSourceRecordContributors(record, search.attributions, declared),
      );
      captured.current.set(record, withCredits);
      return withCredits;
    });
    lastResults.current = next;
    return next;
  }, [enabled, search.data, search.attributions, registry, sourceId]);

  const geojson = useMemo(
    () =>
      buildGeoJson(
        results,
        (value) => {
          if (value === undefined) return undefined;
          if (isI18nToken(value)) return resolveToken(value);
          if (typeof value === "number") return String(value);
          return translateDataSourceSummary(value, t);
        },
        undefined,
        listing?.markerStyle,
      ),
    [results, listing, resolveToken, t],
  );
  const trackGeojson = useMemo(() => buildTrackGeoJson(results), [results]);

  const state: DataSourceOverlayState = !enabled
    ? "idle"
    : search.data
      ? "ready"
      : search.isError
        ? "error"
        : "loading";

  return {
    listing,
    geojson,
    trackGeojson,
    state,
    count: results.length,
    refetch: search.refetch,
  };
}

/**
 * Open a data-source result in the place card, as a click on its category
 * marker does: a preview from what the marker knows shows at once, and the
 * detail request fills it in.
 */
export function openDataSourceItem(
  sourceId: string,
  item: { id: string; name: string; kind?: string },
  coordinates: LngLat,
  listing: Pick<DataSourceListing, "placeCategory" | "placeCategoryRaw"> | null,
): void {
  useDataSourceStore.getState().selectItem(sourceId, item.id);
  usePlaceStore.getState().setSelectedPlace(
    createPlace({
      primaryScheme: sourceId,
      ids: { [sourceId]: item.id },
      name: item.name,
      // A free-floating vehicle's label is not an address; leaving it empty
      // lets the place resolver reverse-geocode a real one.
      address: item.kind === "vehicle" ? "" : item.name,
      coordinates,
      category: listing?.placeCategory,
      rawCategory: listing?.placeCategoryRaw,
    }),
  );
  useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
}

export interface DataSourceKeyEntry {
  id: string;
  label: string;
  color: string;
}

/**
 * The data source's own name in the reader's language, from its integration
 * strings, falling back to the manifest label.
 */
export function useDataSourceName(sourceId: string): string {
  const listing = useDataSourceListing(sourceId);
  const resolveToken = useDataSourceI18nResolver(sourceId);
  const resolved = resolveToken(token("name"));
  return resolved && resolved !== "name" ? resolved : (listing?.name ?? sourceId);
}

/**
 * The colour key for a data source's markers: the options of the filter whose
 * values are the marker variants, each with its variant colour, labelled in
 * the reader's language. Empty when no filter names the variants.
 */
export function useDataSourceColorKey(sourceId: string): DataSourceKeyEntry[] {
  const listing = useDataSourceListing(sourceId);
  const t = useTranslations("dataSources");
  return useMemo(() => {
    if (!listing) return [];
    const colors = listing.markerStyle.variantColors;
    const variantFilter = listing.filters.find(
      (filter) =>
        (filter.options?.length ?? 0) > 0 &&
        filter.options?.every((option) => String(option.id) in colors),
    );
    return (variantFilter?.options ?? []).map((option) => ({
      id: String(option.id),
      label: translateDataSourceLabel(option.label, t),
      color: colors[String(option.id)] as string,
    }));
  }, [listing, t]);
}
