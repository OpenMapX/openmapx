import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Store listing copy, checked against the limits the stores enforce and the
 * claims the app cannot support.
 *
 * The character limits are the boring half: enforcing them here turns a
 * submission rejection into a test failure. The claims are the half that
 * matters. "Fully offline maps" is the single easiest sentence to write about
 * this app and the single most false — the UI is served over the network, and a
 * listing that says otherwise is a promise the first user to open it on a train
 * discovers is untrue.
 */

interface Metadata {
  locale: string;
  apple: {
    name: string;
    subtitle: string;
    description: string;
    keywords: string;
    promotionalText?: string;
    category: string;
    copyright?: string;
  };
  google: {
    name: string;
    shortDescription: string;
    fullDescription: string;
    category: string;
    containsAds: boolean;
  };
  urls: Record<string, string>;
}

const read = (locale: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `${locale}.json`), "utf8")) as Metadata;

const LOCALES = ["en", "de"] as const;
const all = LOCALES.map((locale) => [locale, read(locale)] as const);

/** Sentences the app cannot support, in either language. */
const FORBIDDEN_CLAIMS = [
  "fully offline",
  "works offline",
  "offline maps",
  "always accurate",
  "works after force quit",
  "android auto",
  "carplay",
  "wear os",
  "tablet",
  "vollständig offline",
  "funktioniert offline",
  "offline-karten",
  "immer genau",
];

describe.each(all)("%s metadata", (_locale, metadata) => {
  it("fits Apple's name and subtitle limits", () => {
    expect(metadata.apple.name.length).toBeLessThanOrEqual(30);
    expect(metadata.apple.subtitle.length).toBeLessThanOrEqual(30);
  });

  it("fits Apple's description, keyword and promotional limits", () => {
    expect(metadata.apple.description.length).toBeLessThanOrEqual(4000);
    expect(metadata.apple.keywords.length).toBeLessThanOrEqual(100);
    expect((metadata.apple.promotionalText ?? "").length).toBeLessThanOrEqual(170);
  });

  it("fits Google's limits", () => {
    expect(metadata.google.name.length).toBeLessThanOrEqual(30);
    expect(metadata.google.shortDescription.length).toBeLessThanOrEqual(80);
    expect(metadata.google.fullDescription.length).toBeLessThanOrEqual(4000);
  });

  it("uses the right category on each store", () => {
    expect(metadata.apple.category).toBe("Navigation");
    expect(metadata.google.category).toBe("Maps & Navigation");
  });

  it("declares no ads", () => {
    expect(metadata.google.containsAds).toBe(false);
  });

  it.each(FORBIDDEN_CLAIMS)("makes no claim about %j", (claim) => {
    const copy = [
      metadata.apple.description,
      metadata.apple.subtitle,
      metadata.apple.promotionalText ?? "",
      metadata.google.shortDescription,
      metadata.google.fullDescription,
    ]
      .join(" ")
      .toLowerCase();

    expect(copy).not.toContain(claim);
  });

  it("says a connection is needed to load and to plan", () => {
    // The honest version of the offline story. Omitting it would let the
    // captured-route sentence read as a full offline claim.
    const copy = `${metadata.apple.description} ${metadata.google.fullDescription}`.toLowerCase();

    expect(copy).toMatch(/internet|verbindung/);
  });

  it("names every required public URL", () => {
    for (const key of ["support", "privacy", "terms", "deleteAccount", "marketing", "source"]) {
      expect(metadata.urls[key]).toMatch(/^https:\/\//);
    }
  });

  it("points at the fixed origin for the legal pages", () => {
    for (const key of ["support", "privacy", "terms", "deleteAccount"]) {
      expect(metadata.urls[key].startsWith("https://openmapx.com/")).toBe(true);
    }
  });
});

describe("EN and DE parity", () => {
  const [en, de] = [read("en"), read("de")];

  it("uses the same app name", () => {
    expect(de.apple.name).toBe(en.apple.name);
    expect(de.google.name).toBe(en.google.name);
  });

  it("points at the same URLs", () => {
    expect(de.urls).toEqual(en.urls);
  });

  it("describes background location in both Google descriptions", () => {
    // Google requires background location to be described as core functionality
    // in the listing, not only in the console declaration.
    expect(en.google.fullDescription.toLowerCase()).toContain("background");
    expect(de.google.fullDescription.toLowerCase()).toContain("hintergrund");
  });

  it("says in both that guidance stops when navigation ends", () => {
    expect(en.google.fullDescription.toLowerCase()).toContain("ending navigation stops it");
    expect(de.google.fullDescription.toLowerCase()).toContain("beenden der navigation stoppt es");
  });
});
