// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertValidSecretKey, isValidSecretKey } from "../secret-key";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "integrations")) && existsSync(join(dir, "services"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate repo root (no dir with integrations/ + services/)");
}

function manifestPaths(): string[] {
  const root = repoRoot();
  const out: string[] = [];
  for (const [base, file] of [
    ["integrations", "manifest.json"],
    ["services", "service.json"],
  ] as const) {
    const baseDir = join(root, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith("."))
        continue;
      const p = join(baseDir, entry.name, file);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function findInvalidKeys(): string[] {
  const invalid: string[] = [];
  for (const path of manifestPaths()) {
    let manifest: { configSchema?: { properties?: Record<string, unknown> } };
    try {
      manifest = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    const properties = manifest.configSchema?.properties ?? {};
    for (const key of Object.keys(properties)) {
      if (!isValidSecretKey(key)) invalid.push(`${path} :: ${key}`);
    }
  }
  return invalid;
}

describe("secret key shape", () => {
  it("accepts every real-world key style and the valid boundaries", () => {
    for (const key of [
      "NY_511_API_KEY",
      "LTA_ACCOUNT_KEY",
      "RATE_LIMIT_MAX",
      "apiKey",
      "accessToken",
      "skyscannerMediaPartnerId",
      "de-nw-mobidrom-scooter-client-secret",
      "at-econtrol-referer-domain",
      "tw-tdx-webcam-client-secret",
      "a",
      "A1",
      "a".repeat(64),
    ]) {
      expect(isValidSecretKey(key), key).toBe(true);
    }
  });

  it("rejects traversal, path, and otherwise unsafe shapes", () => {
    for (const key of [
      "../evil",
      "../../etc/passwd",
      "a/b",
      "a\\b",
      "..%2f..",
      ".",
      "..",
      ".hidden",
      "",
      "-leading-dash",
      "_leading_underscore",
      "has space",
      "has.dot",
      "nul\u0000byte",
      "a".repeat(65),
    ]) {
      expect(isValidSecretKey(key), key).toBe(false);
    }
  });

  it("provides a throwing assertion for invalid keys", () => {
    expect(() => assertValidSecretKey("../evil")).toThrow(/Invalid credential key/);
    expect(() => assertValidSecretKey("NY_511_API_KEY")).not.toThrow();
  });
});

describe("every credential key in the repo passes the guard", () => {
  it("accepts every configSchema property name", () => {
    const invalid = findInvalidKeys();
    expect(invalid, `\n${invalid.join("\n")}\n`).toEqual([]);
  });
});
