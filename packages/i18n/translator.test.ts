import { describe, expect, it } from "vitest";
import { defaultLocale, locales, messages, resolveLocale } from "./config";
import { createTranslator } from "./translator";

describe("headless canonical translations", () => {
  it("resolves supported locales, regional tags, and invalid input", () => {
    for (const locale of locales) expect(resolveLocale(locale)).toBe(locale);
    expect(resolveLocale("DE-at")).toBe("de");
    expect(resolveLocale("en-US-u-ca-gregory")).toBe("en");
    for (const value of [undefined, null, "", "unknown", "deceptive", "<script>"]) {
      expect(resolveLocale(value)).toBe(defaultLocale);
    }
  });
  it("falls back per message when a translation is missing", () => {
    const readme = messages.de.privacyExport.readme as Partial<
      typeof messages.de.privacyExport.readme
    >;
    const title = readme.title;
    try {
      delete readme.title;
      const t = createTranslator("de", "privacyExport.readme");
      expect(t("title")).toBe(messages.en.privacyExport.readme.title);
      expect(t.fallbacks()).toEqual([
        {
          key: "privacyExport.readme.title",
          reason: "missing",
          locale: "de",
          fallbackLocale: "en",
        },
      ]);
      expect(t("description")).toBe(readme.description);
      expect(t.has("absent")).toBe(false);
      expect(() => t("absent")).toThrow("Missing translation");
    } finally {
      readme.title = title;
    }
  });
  it("uses English ICU grammar after a malformed localized message and records the fallback", () => {
    const readme = messages.de.privacyExport.readme;
    const original = readme.title;
    const english = messages.en.privacyExport.readme.title;
    try {
      readme.title = "{count, plural, broken";
      messages.en.privacyExport.readme.title =
        "{count, plural, one {# English record} other {# English records}}";
      const t = createTranslator("de-DE", "privacyExport.readme");
      expect(t("title", { count: 2 })).toBe("2 English records");
      expect(t.fallbacks()).toEqual([
        {
          key: "privacyExport.readme.title",
          reason: "invalid-message",
          locale: "de",
          fallbackLocale: "en",
        },
      ]);
    } finally {
      readme.title = original;
      messages.en.privacyExport.readme.title = english;
    }
  });
  it("fails clearly when the English fallback message is malformed", () => {
    const german = messages.de.privacyExport.readme.title;
    const original = messages.en.privacyExport.readme.title;
    try {
      messages.de.privacyExport.readme.title = "{count, plural, broken";
      messages.en.privacyExport.readme.title = "{count, plural, broken";
      const t = createTranslator("de", "privacyExport.readme");
      expect(() => t("title", { count: 2 })).toThrow(
        "Invalid fallback translation: privacyExport.readme.title",
      );
    } finally {
      messages.de.privacyExport.readme.title = german;
      messages.en.privacyExport.readme.title = original;
    }
  });
  it("formats ICU messages from the same catalogue used by the UI", () => {
    const t = createTranslator("en", "privacyExport.readme");
    const original = messages.en.privacyExport.readme.title;
    try {
      messages.en.privacyExport.readme.title =
        "{count, plural, one {# record} other {# records}} for {name}";
      expect(t("title", { count: 2, name: "<Ada>" })).toBe("2 records for <Ada>");
    } finally {
      messages.en.privacyExport.readme.title = original;
    }
  });
});
