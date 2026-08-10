import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Which hosts the installed app can reach.
 *
 * The answer is meant to be "the compiled origin, and nothing else". Every
 * network request the product makes goes through the web UI inside the WebView,
 * which is limited to that origin by both the navigation allowlist and WebKit's
 * App-Bound Domains. The native side itself talks to nobody.
 *
 * This scans the committed native source for anything that looks like an
 * absolute URL. A new hard-coded endpoint — an analytics beacon, a crash
 * reporter, a "just this once" fetch — would appear here, which is the point:
 * the data-practice registry declares what leaves the device, and a host that no
 * row covers is a practice nobody reviewed.
 */

const mobileSrc = resolve(import.meta.dirname, "../src");
const mobileConfig = resolve(import.meta.dirname, "../config");

/** Hosts a string literal may legitimately name in the native source. */
const ALLOWED = new Set([
  // The compiled default origin and its official identity.
  "openmapx.com",
  "www.openmapx.com",
  // Schema and documentation URLs in comments and JSON schemas.
  "json-schema.org",
  "developer.apple.com",
  "developer.android.com",
  "docs.expo.dev",
  "webkit.org",
  "www.rfc-editor.org",
  "www.better-auth.com",
  "nextjs.org",
  "reactnative.dev",
  "github.com",
  "openmapx.org",
  // Localhost forms used by development configuration.
  "localhost",
  "127.0.0.1",
  "10.0.2.2",
]);

/** Files whose URLs are examples rather than endpoints. */
const SKIP_SUFFIXES = [".test.ts", ".test.tsx", ".md", ".json"];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
    if (SKIP_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
    found.push(path);
  }
  return found;
}

/** Strips comments, where documentation links legitimately live. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function hostsIn(source: string): string[] {
  const hosts: string[] = [];
  for (const match of withoutComments(source).matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
    hosts.push(match[1].toLowerCase());
  }
  return hosts;
}

const files = [...sourceFiles(mobileSrc), ...sourceFiles(mobileConfig)];

describe("the installed app's reachable hosts", () => {
  it("finds source files to scan at all", () => {
    // A scan of nothing passes trivially, which would be the worst outcome here.
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((file) => [file.replace(`${resolve(import.meta.dirname, "..")}/`, ""), file]))(
    "%s names no undeclared host",
    (_label, file) => {
      const undeclared = hostsIn(readFileSync(file, "utf8")).filter((host) => !ALLOWED.has(host));

      // A host no data-practice row covers is a transmission nobody reviewed.
      expect(undeclared).toEqual([]);
    },
  );

  it("contains no analytics, crash-reporting or push endpoint", () => {
    const forbidden = [
      "sentry",
      "bugsnag",
      "crashlytics",
      "firebase",
      "amplitude",
      "mixpanel",
      "segment.io",
      "google-analytics",
      "onesignal",
      "expo.dev/--/api/v2/push",
    ];

    for (const file of files) {
      const source = withoutComments(readFileSync(file, "utf8")).toLowerCase();
      for (const needle of forbidden) {
        expect({ file, needle, present: source.includes(needle) }).toEqual({
          file,
          needle,
          present: false,
        });
      }
    }
  });

  it("references no over-the-air update channel", () => {
    for (const file of files) {
      const source = withoutComments(readFileSync(file, "utf8"));
      // `expo-updates` would let a native binary change after review.
      expect(source).not.toContain("expo-updates");
      expect(source).not.toContain("EXPO_UPDATE_URL");
    }
  });
});
