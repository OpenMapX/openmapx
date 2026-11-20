import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dockerIgnoreExcludes } from "./dockerignore";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface ReferenceMatcher {
  add(rules: string[]): ReferenceMatcher;
  ignores(path: string): boolean;
}

const requireFromTest = createRequire(import.meta.url);
const createReferenceMatcher = requireFromTest(
  join(
    WORKSPACE_ROOT,
    "node_modules/.pnpm/@balena+dockerignore@1.0.2/node_modules/@balena/dockerignore/ignore.js",
  ),
) as (options: { ignorecase: boolean }) => ReferenceMatcher;

it("retains coverage source modules while excluding generated coverage reports", () => {
  const matcher = createReferenceMatcher({ ignorecase: false }).add(
    readFileSync(join(WORKSPACE_ROOT, ".dockerignore"), "utf8").split("\n"),
  );
  for (const path of [
    "packages/core/src/coverage/index.ts",
    "apps/api/src/services/coverage/service.ts",
    "services/data-manager/src/coverage/api.ts",
  ])
    expect(matcher.ignores(path), path).toBe(false);
  for (const path of [
    "coverage/lcov.info",
    "apps/web/coverage/lcov.info",
    "packages/core/coverage/lcov.info",
  ])
    expect(matcher.ignores(path), path).toBe(true);
});

describe("Docker ignore matching", () => {
  it("uses ordered last-match semantics for directory exclusions and re-inclusions", () => {
    const rules = ["private/", "!private/public.txt", "private/public.txt"];

    expect(dockerIgnoreExcludes("private/token.txt", rules)).toBe(true);
    expect(dockerIgnoreExcludes("private/public.txt", rules)).toBe(true);
    expect(dockerIgnoreExcludes("private/other/public.txt", rules)).toBe(true);
    expect(dockerIgnoreExcludes("ordinary.txt", rules)).toBe(false);
    expect(dockerIgnoreExcludes("private/public.txt", rules.slice(0, 2))).toBe(false);
  });

  it("anchors bare patterns at the context root while preserving directory and ** semantics", () => {
    const rules = [
      "/root-only.key",
      "cache/",
      "token?.key",
      "**/deep/*.p12",
      "signing-[0-9].jks",
      "credential-[^x].json",
    ];

    expect(dockerIgnoreExcludes("root-only.key", rules)).toBe(true);
    expect(dockerIgnoreExcludes("nested/root-only.key", rules)).toBe(false);
    expect(dockerIgnoreExcludes("cache/item", rules)).toBe(true);
    expect(dockerIgnoreExcludes("nested/cache/item", rules)).toBe(false);
    expect(dockerIgnoreExcludes("token1.key", rules)).toBe(true);
    expect(dockerIgnoreExcludes("nested/token1.key", rules)).toBe(false);
    expect(dockerIgnoreExcludes("one/deep/mobile.p12", rules)).toBe(true);
    expect(dockerIgnoreExcludes("signing-7.jks", rules)).toBe(true);
    expect(dockerIgnoreExcludes("nested/signing-7.jks", rules)).toBe(false);
    expect(dockerIgnoreExcludes("credential-a.json", rules)).toBe(true);
    expect(dockerIgnoreExcludes("credential-x.json", rules)).toBe(false);
  });

  it("uses Go character-class negation and POSIX backslash escape semantics", () => {
    expect(dockerIgnoreExcludes("aze", ["a[^b-d]e"])).toBe(true);
    expect(dockerIgnoreExcludes("ace", ["a[^b-d]e"])).toBe(false);
    expect(dockerIgnoreExcludes("a!e", ["a[!x]e"])).toBe(true);
    expect(dockerIgnoreExcludes("aae", ["a[!x]e"])).toBe(false);
    expect(dockerIgnoreExcludes("literal[prod].key", ["literal\\[prod\\].key"])).toBe(true);
  });

  it("normalizes dot segments without treating POSIX pattern escapes as separators", () => {
    const rules = ["nested/secrets/", "literal\\[prod\\].key"];

    expect(dockerIgnoreExcludes("nested/other/../secrets/token", rules)).toBe(true);
    expect(dockerIgnoreExcludes(String.raw`nested\secrets\token`, rules)).toBe(false);
    expect(dockerIgnoreExcludes("literal[prod].key", rules)).toBe(true);
  });

  it("fails closed for invalid patterns and candidate paths outside the context", () => {
    expect(() => dockerIgnoreExcludes("secret.key", ["secret["])).toThrow(/invalid/i);
    expect(() => dockerIgnoreExcludes("secret.key", ["secret\\"])).toThrow(/invalid/i);
    expect(() => dockerIgnoreExcludes("../secret.key", ["**/*.key"])).toThrow(/outside|unsafe/i);
    expect(() => dockerIgnoreExcludes("/secret.key", ["**/*.key"])).toThrow(/absolute|unsafe/i);
  });

  it.each([
    [["*.pem"], "private.pem"],
    [["*.pem"], "nested/private.pem"],
    [["**/*.pem"], "private.pem"],
    [["**/*.pem"], "nested/private.pem"],
    [["temp?"], "tempa"],
    [["temp?"], "nested/tempa"],
    [["a[b-d]e"], "ace"],
    [["a[b-d]e"], "aze"],
    [["a[^b-d]e"], "aze"],
    [["a[!x]e"], "a!e"],
    [["a[!x]e"], "aae"],
    [["literal\\[prod\\].key"], "literal[prod].key"],
    [["**/foo/bar"], "foo/bar"],
    [["**/foo/bar"], "nested/foo/bar"],
    [["private/", "!private/public.txt"], "private/public.txt"],
    [["private/", "!private/public.txt", "private/public.txt"], "private/public.txt"],
  ])("matches the installed Docker-compatible reference for %j against %s", (rules, path) => {
    const reference = createReferenceMatcher({ ignorecase: false }).add(rules);

    expect(dockerIgnoreExcludes(path, rules)).toBe(reference.ignores(path));
  });

  it.each([
    [".env*", ".env.production", "nested/.env.production", false],
    ["**/.env*", ".env.production", "nested/.env.production", true],
    ["*.pem", "private.pem", "nested/private.pem", false],
    ["**/*.pem", "private.pem", "nested/private.pem", true],
    [
      "infra/docker/secrets/",
      "infra/docker/secrets/token",
      "nested/infra/docker/secrets/token",
      false,
    ],
    ["**/.generated-secrets/", ".generated-secrets/token", "nested/.generated-secrets/token", true],
    ["**/*.key", "signing.key", "nested/signing.key", true],
    ["**/*.jks", "signing.jks", "nested/signing.jks", true],
    ["**/*.keystore", "signing.keystore", "nested/signing.keystore", true],
    ["**/*.p12", "signing.p12", "nested/signing.p12", true],
    ["**/*.mobileprovision", "signing.mobileprovision", "nested/signing.mobileprovision", true],
    ["**/*.ipa", "application.ipa", "nested/application.ipa", true],
    ["**/*.aab", "application.aab", "nested/application.aab", true],
    ["**/*.apk", "application.apk", "nested/application.apk", true],
    ["apps/mobile/ios/", "apps/mobile/ios/key", "nested/apps/mobile/ios/key", false],
    ["apps/mobile/android/", "apps/mobile/android/key", "nested/apps/mobile/android/key", false],
    ["apps/mobile/.expo/", "apps/mobile/.expo/key", "nested/apps/mobile/.expo/key", false],
    ["apps/mobile/.gradle/", "apps/mobile/.gradle/key", "nested/apps/mobile/.gradle/key", false],
  ])(
    "applies root and nested scope for policy rule %s",
    (rule, rootPath, nestedPath, nestedExcluded) => {
      expect(dockerIgnoreExcludes(rootPath, [rule])).toBe(true);
      expect(dockerIgnoreExcludes(nestedPath, [rule])).toBe(nestedExcluded);
    },
  );

  it("honors the retained root environment example re-inclusion after the root environment rule", () => {
    expect(dockerIgnoreExcludes(".env.example", [".env*", "!.env.example"])).toBe(false);
    expect(dockerIgnoreExcludes(".env.production", [".env*", "!.env.example"])).toBe(true);
  });
});
