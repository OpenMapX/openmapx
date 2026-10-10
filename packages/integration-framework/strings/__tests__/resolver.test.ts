import { describe, expect, it } from "vitest";
import { resolveToken } from "../src/resolver.js";
import { money, sharedStrings } from "../src/token.js";

const charging = {
  en: { price: { energy: "{amount}/kWh" } },
  de: { price: { energy: "{amount}/kWh" } },
};

const shared = {
  en: {
    shared: {
      row: { source: "Source", lastUpdated: "Last Updated" },
      value: { open: "Open" },
    },
  },
  de: {
    shared: {
      row: { source: "Quelle", lastUpdated: "Zuletzt aktualisiert" },
      value: { open: "Geöffnet" },
    },
  },
};

const parking = {
  en: {
    row: { freeSpaces: "Free Spaces" },
    summary: { spacesOf: "{free}/{capacity} free" },
  },
  de: {
    row: { freeSpaces: "Freie Plätze" },
    summary: { spacesOf: "{free}/{capacity} frei" },
  },
};

describe("resolveToken", () => {
  it("resolves a shared.* token against the framework catalog", () => {
    const out = resolveToken(
      { $t: "shared.row.source" },
      { locale: "de", fallbackLocale: "en", shared, integration: undefined },
    );
    expect(out).toBe("Quelle");
  });

  it("resolves a token-valued placeholder first, in the same locale", () => {
    const out = resolveToken(
      { $t: "summary.spacesOf", values: { free: { $t: "row.freeSpaces" }, capacity: 10 } },
      { locale: "de", fallbackLocale: "en", shared, integration: parking },
    );
    expect(out).toBe("Freie Plätze/10 frei");
  });

  it("formats a money placeholder in the reader's locale", () => {
    const price = money(0.389, "EUR");
    const at = (locale: string) =>
      resolveToken(
        { $t: "price.energy", values: { amount: price } },
        { locale, fallbackLocale: "en", shared: sharedStrings, integration: charging },
      );
    expect(at("en")).toBe("€0.389/kWh");
    expect(at("de")).toBe("0,389 €/kWh");
    // A money token stands alone too, e.g. as a table cell.
    expect(
      resolveToken(money(2, "CHF"), {
        locale: "de",
        fallbackLocale: "en",
        shared: sharedStrings,
        integration: undefined,
      }),
    ).toBe("2,00 CHF");
  });

  it("passes a null or undefined placeholder through as before", () => {
    const values = { free: null, capacity: undefined } as unknown as Record<string, number>;
    const out = resolveToken(
      { $t: "summary.spacesOf", values },
      { locale: "en", fallbackLocale: "en", shared, integration: parking },
    );
    expect(typeof out).toBe("string");
  });

  it("resolves an integration-scoped token against the integration catalog", () => {
    const out = resolveToken(
      { $t: "row.freeSpaces" },
      { locale: "de", fallbackLocale: "en", shared, integration: parking },
    );
    expect(out).toBe("Freie Plätze");
  });

  it("interpolates ICU values", () => {
    const out = resolveToken(
      { $t: "summary.spacesOf", values: { free: 12, capacity: 50 } },
      { locale: "de", fallbackLocale: "en", shared, integration: parking },
    );
    expect(out).toBe("12/50 frei");
  });

  it("falls back to fallbackLocale when the active locale is missing the key", () => {
    const out = resolveToken(
      { $t: "row.freeSpaces" },
      { locale: "fr", fallbackLocale: "en", shared, integration: parking },
    );
    expect(out).toBe("Free Spaces");
  });

  it("falls back from integration catalog to framework catalog for non-shared keys", () => {
    // Integration has no "row.lastUpdated" entry, but framework does.
    const out = resolveToken(
      { $t: "row.lastUpdated" },
      { locale: "de", fallbackLocale: "en", shared, integration: parking },
    );
    expect(out).toBe("Zuletzt aktualisiert");
  });

  it("returns the key verbatim when no catalog has the key (visible-bug fallback)", () => {
    const out = resolveToken(
      { $t: "row.completelyUnknown" },
      { locale: "de", fallbackLocale: "en", shared, integration: parking },
    );
    expect(out).toBe("row.completelyUnknown");
  });

  it("treats shared.* keys as framework-only — does NOT look in integration catalog", () => {
    const integrationWithSharedKey = {
      en: { shared: { row: { source: "SHOULD NOT WIN" } } },
    };
    const out = resolveToken(
      { $t: "shared.row.source" },
      {
        locale: "en",
        fallbackLocale: "en",
        shared,
        integration: integrationWithSharedKey,
      },
    );
    expect(out).toBe("Source");
  });

  it("falls back to the raw template (does not throw) when the ICU template is malformed", () => {
    const broken = {
      en: { summary: { broken: "{count, plural, one {x}" } },
    };
    const out = resolveToken(
      { $t: "summary.broken", values: { count: 3 } },
      { locale: "en", fallbackLocale: "en", shared, integration: broken },
    );
    expect(out).toBe("{count, plural, one {x}");
  });

  it("treats an empty-string catalog value as missing and continues the fallback chain", () => {
    const integration = {
      en: { row: { freeSpaces: "Free Spaces" } },
      de: { row: { freeSpaces: "" } },
    };
    const out = resolveToken(
      { $t: "row.freeSpaces" },
      { locale: "de", fallbackLocale: "en", shared, integration },
    );
    expect(out).toBe("Free Spaces");
  });
});
