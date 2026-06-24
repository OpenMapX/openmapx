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

/** Severity → badge colors, matching the marker severity ramp. */
const SEVERITY_STYLE: Record<string, { bg: string; fg: string }> = {
  critical: { bg: "#7e0023", fg: "#ffffff" },
  high: { bg: "#cc0033", fg: "#ffffff" },
  medium: { bg: "#ff9933", fg: "#3a2a00" },
  low: { bg: "#ffde33", fg: "#3a2a00" },
  unknown: { bg: "#8a8a8a", fg: "#ffffff" },
};

/** Humanize an enum-ish token: "road_closure" → "Road closure". */
function humanize(raw: string): string {
  const s = raw.replace(/[_-]+/g, " ").trim();
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Format a value to a display string. Returns "" for values that can't be
 * sensibly stringified (objects/arrays/null), so the caller drops the row
 * rather than printing "[object Object]".
 */
function formatValue(raw: unknown, format?: "text" | "number" | "date" | "label"): string {
  if (raw == null || typeof raw === "object") return "";
  if (format === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n.toLocaleString() : String(raw);
  }
  if (format === "date") {
    const d = new Date(String(raw));
    return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleDateString();
  }
  if (format === "label") return humanize(String(raw));
  return String(raw);
}

/** Resolve the attribution credit from a string or an {provider,license} object. */
function attributionText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw != null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const provider = typeof o.provider === "string" ? o.provider : "";
    const license = typeof o.license === "string" ? o.license : "";
    return provider && license ? `${provider} · ${license}` : provider || license;
  }
  return "";
}

/**
 * Render a declarative popup as a structured card with EVERY value and label
 * escaped — community overlays never inject raw HTML. The card has a header
 * (title + optional colored severity badge), compact chips, label/value rows,
 * full-width text blocks, and a muted attribution footer. Rows whose field is
 * absent/empty (or holds an object) are omitted.
 */
export function buildPopupHtml(
  popup: IntegrationOverlayPopup,
  properties: Record<string, unknown>,
  resolveLabel?: (key: string) => string,
): string {
  const title = escapeHtml(String(properties[popup.titleField] ?? ""));

  let badge = "";
  if (popup.severityField) {
    const sevRaw = properties[popup.severityField];
    if (sevRaw != null && sevRaw !== "") {
      const style = SEVERITY_STYLE[String(sevRaw).toLowerCase()] ?? SEVERITY_STYLE.unknown;
      badge = `<span class="omx-overlay-popup__badge" style="background:${style.bg};color:${style.fg}">${escapeHtml(humanize(String(sevRaw)))}</span>`;
    }
  }
  const header = `<div class="omx-overlay-popup__header"><span class="omx-overlay-popup__title">${title}</span></div>`;

  const chips: string[] = [];
  const rows: string[] = [];
  const blocks: string[] = [];
  for (const r of popup.rows ?? []) {
    const value = formatValue(properties[r.field], r.format);
    if (value === "") continue;
    const label = escapeHtml(labelFor(r, resolveLabel));
    const safe = escapeHtml(value);
    if (r.variant === "chip") {
      chips.push(`<span class="omx-overlay-popup__chip">${safe}</span>`);
    } else if (r.variant === "block") {
      blocks.push(
        `<div class="omx-overlay-popup__block"><span class="omx-overlay-popup__block-label">${label}</span><p class="omx-overlay-popup__text">${safe}</p></div>`,
      );
    } else {
      rows.push(
        `<div class="omx-overlay-popup__row"><span class="omx-overlay-popup__label">${label}</span><span class="omx-overlay-popup__value">${safe}</span></div>`,
      );
    }
  }
  // The severity badge leads the meta line (it sits below the title, clear of
  // the close button) alongside any chips.
  const metaItems = badge ? [badge, ...chips] : chips;
  const chipsHtml = metaItems.length
    ? `<div class="omx-overlay-popup__chips">${metaItems.join("")}</div>`
    : "";

  let footer = "";
  if (popup.attributionField) {
    const attr = attributionText(properties[popup.attributionField]);
    if (attr) footer = `<div class="omx-overlay-popup__footer">${escapeHtml(attr)}</div>`;
  }

  return `<div class="omx-overlay-popup">${header}${chipsHtml}${rows.join("")}${blocks.join("")}${footer}</div>`;
}
