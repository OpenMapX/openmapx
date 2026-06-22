import { escapeHtml } from "@openmapx/core";
import type {
  IntegrationOverlayPopup,
  IntegrationOverlayPopupRow,
  IntegrationOverlaySource,
} from "@openmapx/integration-framework";

/** Viewport in lng/lat extents, as MapLibre's `LngLatBounds` decomposes to. */
export interface OverlayBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Source/layer ids are namespaced so multiple overlays can't collide on the map. */
export function namespacedSourceId(integrationId: string): string {
  return `omx-ext:${integrationId}`;
}

export function namespacedLayerId(integrationId: string, layerId: string): string {
  return `omx-ext:${integrationId}:${layerId}`;
}

/**
 * Build the fetch URL for a declarative overlay source. Points at the
 * integration's own backend route (`/api/integrations/<id><route>`) with the
 * viewport substituted per `bboxParam`, plus any static (`extraParams`) and
 * dynamic (panel-driven) query params.
 */
export function buildOverlaySourceUrl(
  apiBase: string,
  integrationId: string,
  source: IntegrationOverlaySource,
  bounds: OverlayBounds,
  dynamicParams?: Record<string, string>,
): string {
  const base = apiBase.replace(/\/$/, "");
  const route = source.route ?? "";
  const path = route.startsWith("/") ? route : `/${route}`;
  const params = new URLSearchParams();

  const { west, south, east, north } = bounds;
  if (source.bboxParam === "wsen") {
    params.set("west", String(west));
    params.set("south", String(south));
    params.set("east", String(east));
    params.set("north", String(north));
  } else {
    params.set("bbox", `${west},${south},${east},${north}`);
  }

  for (const [k, v] of Object.entries(source.extraParams ?? {})) params.set(k, v);
  for (const [k, v] of Object.entries(dynamicParams ?? {})) params.set(k, v);

  return `${base}/api/integrations/${integrationId}${path}?${params.toString()}`;
}

function labelFor(row: IntegrationOverlayPopupRow, resolveLabel?: (key: string) => string): string {
  if (row.label) return row.label;
  if (row.labelKey) return resolveLabel ? resolveLabel(row.labelKey) : row.labelKey;
  return row.field;
}

function formatValue(raw: unknown, format?: "text" | "number" | "date"): string {
  if (format === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n.toLocaleString() : String(raw);
  }
  if (format === "date") {
    const d = new Date(String(raw));
    return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleDateString();
  }
  return String(raw);
}

/**
 * Render a declarative popup to an HTML string with EVERY value and label
 * escaped — community overlays never inject raw HTML. Rows whose field is absent
 * (or empty) from the feature properties are omitted.
 */
export function buildPopupHtml(
  popup: IntegrationOverlayPopup,
  properties: Record<string, unknown>,
  resolveLabel?: (key: string) => string,
): string {
  const title = escapeHtml(String(properties[popup.titleField] ?? ""));
  const rowsHtml = (popup.rows ?? [])
    .filter((r) => {
      const v = properties[r.field];
      return v != null && v !== "";
    })
    .map((r) => {
      const label = escapeHtml(labelFor(r, resolveLabel));
      const value = escapeHtml(formatValue(properties[r.field], r.format));
      return `<div class="omx-overlay-popup__row"><span class="omx-overlay-popup__label">${label}</span><span class="omx-overlay-popup__value">${value}</span></div>`;
    })
    .join("");
  return `<div class="omx-overlay-popup"><div class="omx-overlay-popup__title">${title}</div>${rowsHtml}</div>`;
}
