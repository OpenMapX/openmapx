import deShared from "../locales/de.json" with { type: "json" };
import enShared from "../locales/en.json" with { type: "json" };
import type { I18nToken, LocaleStrings } from "./types.js";

/**
 * The framework's shared-vocabulary catalog. Indexed by locale code; each
 * locale ships the same `shared.*` namespace tree. Bundled at build time so
 * the framework remains usable without filesystem access (works in the
 * browser, in unit tests, in mobile clients that vendor the JSON).
 */
export const sharedStrings: LocaleStrings = {
  en: enShared,
  de: deShared,
};

/**
 * Build a translation token. Use this when emitting integration-scoped
 * labels — keys resolve against the emitting integration's strings catalog
 * (with framework strings as fallback for non-`shared.*` keys).
 *
 * For shared vocabulary, prefer `sharedT.*` typed constants below.
 */
export function token(key: string, values?: Record<string, string | number>): I18nToken {
  return values ? { $t: key, values } : { $t: key };
}

/**
 * Typed accessors for the framework's shared catalog. Use these wherever an
 * integration's mapper wants to emit cross-integration vocabulary (Source,
 * Last Updated, Open, etc.). Editor autocomplete prevents typos.
 *
 * Adding a new shared label: add it under the appropriate section in both
 * `locales/en.json` and `locales/de.json`, then add the typed constant here.
 * The check-translations script enforces parity.
 */
export const sharedT = {
  section: {
    source: { $t: "shared.section.source" } as I18nToken,
    notes: { $t: "shared.section.notes" } as I18nToken,
    pricing: { $t: "shared.section.pricing" } as I18nToken,
    availability: { $t: "shared.section.availability" } as I18nToken,
    facility: { $t: "shared.section.facility" } as I18nToken,
    access: { $t: "shared.section.access" } as I18nToken,
    dataQuality: { $t: "shared.section.dataQuality" } as I18nToken,
    payment: { $t: "shared.section.payment" } as I18nToken,
    info: { $t: "shared.section.info" } as I18nToken,
  },
  row: {
    source: { $t: "shared.row.source" } as I18nToken,
    sources: { $t: "shared.row.sources" } as I18nToken,
    sourceId: { $t: "shared.row.sourceId" } as I18nToken,
    sourceUrl: { $t: "shared.row.sourceUrl" } as I18nToken,
    license: { $t: "shared.row.license" } as I18nToken,
    lastUpdated: { $t: "shared.row.lastUpdated" } as I18nToken,
    type: { $t: "shared.row.type" } as I18nToken,
    capacity: { $t: "shared.row.capacity" } as I18nToken,
    status: { $t: "shared.row.status" } as I18nToken,
    access: { $t: "shared.row.access" } as I18nToken,
    address: { $t: "shared.row.address" } as I18nToken,
    operator: { $t: "shared.row.operator" } as I18nToken,
  },
  value: {
    yes: { $t: "shared.value.yes" } as I18nToken,
    no: { $t: "shared.value.no" } as I18nToken,
    open: { $t: "shared.value.open" } as I18nToken,
    closed: { $t: "shared.value.closed" } as I18nToken,
    stale: { $t: "shared.value.stale" } as I18nToken,
    unknown: { $t: "shared.value.unknown" } as I18nToken,
    customers: { $t: "shared.value.customers" } as I18nToken,
    private: { $t: "shared.value.private" } as I18nToken,
    permit: { $t: "shared.value.permit" } as I18nToken,
    public: { $t: "shared.value.public" } as I18nToken,
  },
} as const;
