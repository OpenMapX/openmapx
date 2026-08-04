import { escapeHtml } from "@openmapx/core";

/**
 * A single row in an overlay popup card. `format: "label"` humanizes enum-ish
 * values ("road_closure" → "Road closure"); `variant` controls layout — a
 * compact `chip`, a full-width `block` (long text, line breaks preserved), or a
 * default label/value `row`.
 */
export interface PopupCardRow {
  field: string;
  label?: string;
  labelKey?: string;
  format?: "text" | "number" | "date" | "label";
  variant?: "row" | "chip" | "block";
}

/**
 * Code-defined spec for an overlay popup card. Integrations build this in their
 * `map-layer.tsx` and render it with {@link buildPopupCard} — no manifest schema
 * involved, so they have full freedom over the fields and formatting.
 */
export interface PopupCardSpec {
  titleField: string;
  /** Field whose value (low|medium|high|critical|unknown) → colored severity badge. */
  severityField?: string;
  /** Optional field containing the localized text for the severity badge. */
  severityLabelField?: string;
  /** Field holding a source credit — a string or `{ provider, license }` → muted footer. */
  attributionField?: string;
  rows?: PopupCardRow[];
}

/** Additional records attached to one visible popup card. */
export interface PopupCardDetails {
  /** Escaped and shown in the closed disclosure summary. */
  label: string;
  /** Source/detail records rendered only after the disclosure is opened. */
  entries: Record<string, unknown>[];
  /** Optional compact spec for detail records; defaults to the card spec. */
  spec?: PopupCardSpec;
}

/** One user-facing card in a popup stack. */
export interface PopupCardStackItem {
  properties: Record<string, unknown>;
  details?: PopupCardDetails;
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

function labelFor(row: PopupCardRow, resolveLabel?: (key: string) => string): string {
  if (row.label) return row.label;
  if (row.labelKey) return resolveLabel ? resolveLabel(row.labelKey) : row.labelKey;
  return row.field;
}

/**
 * Format a value to a display string. Returns "" for values that can't be
 * sensibly stringified (objects/arrays/null), so the caller drops the row
 * rather than printing "[object Object]".
 */
function formatValue(raw: unknown, format?: PopupCardRow["format"]): string {
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
 * Renders the card body — header (title), a meta line (colored severity badge +
 * chips), label/value rows, full-width text blocks, and a muted attribution
 * footer — as an HTML string with EVERY value and label escaped. Rows whose
 * field is absent/empty (or holds an object) are omitted. Returned WITHOUT the
 * outer `.omx-overlay-popup` wrapper so it can be rendered standalone or stacked.
 * Styled by the `.omx-overlay-popup*` classes in globals.css.
 */
function renderCardBody(
  spec: PopupCardSpec,
  properties: Record<string, unknown>,
  resolveLabel?: (key: string) => string,
): string {
  const title = escapeHtml(String(properties[spec.titleField] ?? ""));

  let badge = "";
  if (spec.severityField) {
    const sevRaw = properties[spec.severityField];
    // Skip the badge for an unknown/empty severity — many sources (e.g. the
    // Mobilithek roadworks feed) send `severity=unknown`, and a meaningless
    // "UNKNOWN" pill is just noise. The marker still carries the unknown color.
    if (sevRaw != null && sevRaw !== "" && String(sevRaw).toLowerCase() !== "unknown") {
      const style = SEVERITY_STYLE[String(sevRaw).toLowerCase()] ?? SEVERITY_STYLE.unknown;
      const labelRaw = spec.severityLabelField ? properties[spec.severityLabelField] : undefined;
      const label =
        labelRaw == null || String(labelRaw).trim() === ""
          ? humanize(String(sevRaw))
          : String(labelRaw);
      badge = `<span class="omx-overlay-popup__badge" style="background:${style.bg};color:${style.fg}">${escapeHtml(label)}</span>`;
    }
  }
  const header = `<div class="omx-overlay-popup__header"><span class="omx-overlay-popup__title">${title}</span></div>`;

  const chips: string[] = [];
  const rows: string[] = [];
  const blocks: string[] = [];
  for (const r of spec.rows ?? []) {
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
  // The severity badge leads the meta line (clear of the close button) with chips.
  const metaItems = badge ? [badge, ...chips] : chips;
  const chipsHtml = metaItems.length
    ? `<div class="omx-overlay-popup__chips">${metaItems.join("")}</div>`
    : "";

  let footer = "";
  if (spec.attributionField) {
    const attr = attributionText(properties[spec.attributionField]);
    if (attr) footer = `<div class="omx-overlay-popup__footer">${escapeHtml(attr)}</div>`;
  }

  return `${header}${chipsHtml}${rows.join("")}${blocks.join("")}${footer}`;
}

function renderPopupDetails(
  details: PopupCardDetails,
  fallbackSpec: PopupCardSpec,
  resolveLabel?: (key: string) => string,
): string {
  if (details.entries.length === 0) return "";
  const spec = details.spec ?? fallbackSpec;
  const entries = details.entries
    .map(
      (entry) =>
        `<div class="omx-overlay-popup__details-entry">${renderCardBody(spec, entry, resolveLabel)}</div>`,
    )
    .join("");
  return `<details class="omx-overlay-popup__details"><summary class="omx-overlay-popup__details-summary">${escapeHtml(details.label)}</summary><div class="omx-overlay-popup__details-body">${entries}</div></details>`;
}

/** A single overlay popup card. */
export function buildPopupCard(
  spec: PopupCardSpec,
  properties: Record<string, unknown>,
  resolveLabel?: (key: string) => string,
): string {
  return `<div class="omx-overlay-popup">${renderCardBody(spec, properties, resolveLabel)}</div>`;
}

/**
 * Renders structured popup items. Each item is one user-facing card; optional
 * source records stay inside that card's closed disclosure instead of becoming
 * additional stack entries. The item order is preserved.
 */
export function buildStackedPopupCardItems(
  spec: PopupCardSpec,
  items: PopupCardStackItem[],
  resolveLabel?: (key: string) => string,
  countLabel?: string,
): string {
  if (items.length === 0) return `<div class="omx-overlay-popup" />`;
  const firstItem = items[0];
  if (items.length === 1 && firstItem && !firstItem.details) {
    return buildPopupCard(spec, firstItem.properties, resolveLabel);
  }

  const head =
    items.length > 1 && countLabel
      ? `<div class="omx-overlay-popup__count">${escapeHtml(countLabel)}</div>`
      : "";
  const renderItem = (item: PopupCardStackItem) => {
    const body = renderCardBody(spec, item.properties, resolveLabel);
    const details = item.details ? renderPopupDetails(item.details, spec, resolveLabel) : "";
    return `${body}${details}`;
  };
  const sections =
    items.length === 1 && firstItem
      ? renderItem(firstItem)
      : items
          .map((item) => `<div class="omx-overlay-popup__section">${renderItem(item)}</div>`)
          .join("");
  const stackClass = items.length > 1 ? " omx-overlay-popup--stack" : "";
  return `<div class="omx-overlay-popup${stackClass}">${head}${sections}</div>`;
}

/**
 * A popup listing several features that share (nearly) the same location — used
 * when markers overlap so all of them stay reachable in one click. `countLabel`
 * heads the stack (e.g. "3 conditions here"); each entry is a full card body
 * separated by a divider, and the whole stack scrolls if tall. Pass the entries
 * already ordered (most severe first) — this does not sort.
 */
export function buildStackedPopupCard(
  spec: PopupCardSpec,
  entries: Record<string, unknown>[],
  resolveLabel?: (key: string) => string,
  countLabel?: string,
): string {
  return buildStackedPopupCardItems(
    spec,
    entries.map((properties) => ({ properties })),
    resolveLabel,
    countLabel,
  );
}
