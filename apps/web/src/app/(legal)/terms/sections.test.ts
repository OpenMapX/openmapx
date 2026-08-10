// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TERMS_SECTION_KEYS, termsIds, termsNav, termsSectionId, termsTitles } from "./sections";

const LOCALES = ["en", "de"] as const;

function content(locale: (typeof LOCALES)[number]): string {
  return readFileSync(fileURLToPath(new URL(`./content.${locale}.tsx`, import.meta.url)), "utf8");
}

describe("key ordering", () => {
  it("keeps a single ordered key list shared by both locales", () => {
    expect(TERMS_SECTION_KEYS.length).toBeGreaterThan(0);
    expect(new Set(TERMS_SECTION_KEYS).size).toBe(TERMS_SECTION_KEYS.length);
    for (const locale of LOCALES) {
      expect(Object.keys(termsTitles(locale))).toEqual([...TERMS_SECTION_KEYS]);
      expect(termsNav(locale)).toHaveLength(TERMS_SECTION_KEYS.length);
    }
  });

  it("places OpenStreetMap contributions directly after reviews", () => {
    const keys = [...TERMS_SECTION_KEYS];
    expect(keys.indexOf("osmContributions")).toBe(keys.indexOf("reviews") + 1);
    expect(keys.indexOf("dataSources")).toBe(keys.indexOf("osmContributions") + 1);
  });
});

describe("numbering", () => {
  it("numbers every numbered section sequentially from 1", () => {
    for (const locale of LOCALES) {
      const numbers = Object.values(termsTitles(locale))
        .map((title) => /^(\d+)\./.exec(title)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    }
  });

  it("numbers both locales identically", () => {
    const numbersFor = (locale: (typeof LOCALES)[number]) =>
      TERMS_SECTION_KEYS.map((key) => /^(\d+)\./.exec(termsTitles(locale)[key])?.[1] ?? null);
    expect(numbersFor("en")).toEqual(numbersFor("de"));
  });
});

describe("anchors", () => {
  it("produces unique, non-empty anchors", () => {
    for (const locale of LOCALES) {
      const ids = TERMS_SECTION_KEYS.map((key) => termsSectionId(locale, key));
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(/^[a-z0-9][a-z0-9-]*$/.test(id)).toBe(true);
    }
  });

  it("keeps the two stable anchors stable across renumbering", () => {
    for (const locale of LOCALES) {
      expect(termsIds(locale).aiSearch).toBe("ai-search");
      expect(termsIds(locale).dataSources).toBe("data-sources");
      expect(termsSectionId(locale, "aiSearch")).toBe("ai-search");
      expect(termsSectionId(locale, "dataSources")).toBe("data-sources");
    }
  });

  it("gives the sidebar the same anchors the content renders", () => {
    for (const locale of LOCALES) {
      const nav = termsNav(locale).map((section) => section.id);
      const rendered = TERMS_SECTION_KEYS.map((key) => termsSectionId(locale, key));
      expect(nav).toEqual(rendered);
    }
  });
});

describe("content wiring", () => {
  it("renders every section from the shared titles", () => {
    for (const locale of LOCALES) {
      const source = content(locale);
      for (const key of TERMS_SECTION_KEYS) {
        expect(source).toContain(`title={T.${key}}`);
      }
    }
  });

  it("hardcodes no numbered heading of its own", () => {
    for (const locale of LOCALES) {
      // A literal `<Section title="7. …">` is exactly the drift this replaced.
      expect(/<Section\s+title="\d+\./.test(content(locale))).toBe(false);
    }
  });

  it("covers the OpenStreetMap contribution obligations", () => {
    for (const locale of LOCALES) {
      const source = content(locale);
      for (const marker of locale === "en"
        ? [
            "Contributor Terms",
            "osmfoundation.org/wiki/Licence/Contributor_Terms",
            "own linked OpenStreetMap account",
          ]
        : [
            "Mitwirkendenbedingungen",
            "osmfoundation.org/wiki/Licence/Contributor_Terms",
            "verkn&uuml;pften OpenStreetMap-Konto",
          ]) {
        expect(source).toContain(marker);
      }
    }
  });
});

describe("labels", () => {
  it("gives every section a non-empty sidebar label", () => {
    for (const locale of LOCALES) {
      for (const section of termsNav(locale)) {
        expect(section.label.trim()).not.toBe("");
      }
    }
  });

  it("keeps the sidebar labels distinct within a locale", () => {
    for (const locale of LOCALES) {
      const labels = termsNav(locale).map((section) => section.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});
