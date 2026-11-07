// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  maskSecretConfigRecord,
  maskSecretConfigValues,
  SENSITIVE_KEY_NAME_RE,
} from "../mask-config.js";

const PLACEHOLDER = "placeholder-not-a-real-value";

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

function configSchemaFromManifest(path: string): Record<string, unknown> | undefined {
  const manifest = JSON.parse(readFileSync(path, "utf-8")) as {
    configSchema?: Record<string, unknown>;
  };
  return manifest.configSchema;
}

function declaredSecretKeys(schema: Record<string, unknown> | undefined): string[] {
  const fields = schema?.properties ?? schema ?? {};
  return Object.entries(fields).flatMap(([key, value]) =>
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>)["x-openmapx-secret"] === true
      ? [key]
      : [],
  );
}

describe("maskSecretConfigValues", () => {
  it.each(["vault", "env", "database", "config.json", "default"])(
    "masks a declared secret from %s",
    (source) => {
      const schema = { properties: { clientId: { type: "string", "x-openmapx-secret": true } } };
      const masked = maskSecretConfigValues({ clientId: { value: PLACEHOLDER, source } }, schema);

      expect(masked.clientId).toMatchObject({ value: "***", source });
    },
  );

  it("uses the regex belt for an undeclared sensitive-looking key", () => {
    const masked = maskSecretConfigValues(
      { apiKey: { value: "x", source: "env" } },
      { properties: {} },
    );

    expect(masked.apiKey).toMatchObject({ value: "***", source: "env" });
  });

  it("does not mask a default-sourced undeclared sensitive-looking key", () => {
    const entry = { value: "x", source: "default" };
    const masked = maskSecretConfigValues({ apiKey: entry }, { properties: {} });

    expect(masked.apiKey).toBe(entry);
  });

  it("passes non-secret keys through unchanged, including their source", () => {
    const entry = { value: 30, source: "database" };
    const masked = maskSecretConfigValues({ timeout: entry }, { properties: {} });

    expect(masked.timeout).toBe(entry);
  });

  it("falls back to regex-only behavior when configSchema is undefined", () => {
    const masked = maskSecretConfigValues({ apiKey: { value: "x", source: "env" } }, undefined);

    expect(masked.apiKey).toMatchObject({ value: "***", source: "env" });
  });

  it("handles a bare-property-map schema shape", () => {
    const masked = maskSecretConfigValues(
      { clientId: { value: PLACEHOLDER, source: "vault" } },
      { clientId: { "x-openmapx-secret": true } },
    );

    expect(masked.clientId).toMatchObject({ value: "***", source: "vault" });
  });
});

describe("maskSecretConfigRecord", () => {
  it("masks declared and regex-matching keys in a flat record", () => {
    const masked = maskSecretConfigRecord(
      { clientId: PLACEHOLDER, apiKey: "x", timeout: 30 },
      { properties: { clientId: { "x-openmapx-secret": true } } },
    );

    expect(masked).toEqual({ clientId: "***", apiKey: "***", timeout: 30 });
  });
});

describe("repo-wide declared-secret masking guard", () => {
  it("masks every declared secret in every shipped manifest", () => {
    const violations: string[] = [];

    for (const manifestPath of manifestPaths()) {
      const configSchema = configSchemaFromManifest(manifestPath);
      const keys = declaredSecretKeys(configSchema);
      const resolvedConfig: Record<string, { value: unknown; source: string }> = Object.fromEntries(
        keys.map((key) => [key, { value: PLACEHOLDER, source: "default" }]),
      );
      const masked = maskSecretConfigValues(resolvedConfig, configSchema);

      for (const key of keys) {
        if (masked[key]?.value !== "***") violations.push(`${manifestPath} :: ${key}`);
      }
    }

    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });

  it("actually scans enough manifests and declared secrets", () => {
    const paths = manifestPaths();
    expect(paths.length).toBeGreaterThan(20);

    const secretCount = paths.reduce(
      (count, path) => count + declaredSecretKeys(configSchemaFromManifest(path)).length,
      0,
    );
    expect(secretCount).toBeGreaterThan(40);
  });

  it("masks a real clientId field that the name regex does not match", () => {
    const manifestPath = join(repoRoot(), "integrations", "live-transit-db-ris", "manifest.json");
    const configSchema = configSchemaFromManifest(manifestPath);

    expect(SENSITIVE_KEY_NAME_RE.test("clientId")).toBe(false);
    const masked = maskSecretConfigValues(
      { clientId: { value: "placeholder", source: "vault" } },
      configSchema,
    );
    expect(masked.clientId?.value).toBe("***");
  });
});
