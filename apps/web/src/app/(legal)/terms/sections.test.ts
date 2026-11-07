import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TermsContentDe from "./content.de";
import TermsContent from "./content.en";
// @vitest-environment node

import { describe, expect, it } from "vitest";
import { TERMS_SECTION_KEYS, termsIds, termsNav, termsSectionId, termsTitles } from "./sections";

const LOCALES = ["en", "de"] as const;
const contentByLocale = new Map<string, string>();
function content(locale: (typeof LOCALES)[number]): string {
  let markup = contentByLocale.get(locale);
  if (markup === undefined) {
    markup = renderToStaticMarkup(
      createElement(locale === "en" ? TermsContent : TermsContentDe, {
        disclosures: [
          {
            type: "ai-search",
            integrationId: "synthetic-ai",
            aiActive: true,
            localActive: true,
            cloudActive: false,
            cloudProcessors: [],
            cloudAvailable: false,
            cloudConsentRequired: false,
            cloudProviderLabels: [],
          },
        ],
      }),
    );
    contentByLocale.set(locale, markup);
  }
  return markup;
}

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
      const rendered = [...content(locale).matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
      expect(rendered).toEqual(termsNav(locale).map((section) => section.id));
    }
  });
});

describe("content wiring", () => {
  it("covers the OpenStreetMap contribution obligations", () => {
    for (const locale of LOCALES) {
      const markup = content(locale);
      expect(markup).toContain('href="https://osmfoundation.org/wiki/Licence/Contributor_Terms"');
      expect(markup).toContain(
        locale === "en" ? "own linked OpenStreetMap account" : "verknüpften OpenStreetMap-Konto",
      );
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
