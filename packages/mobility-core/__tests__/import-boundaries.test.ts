import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MOBILITY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CORE_ROOT = fileURLToPath(new URL("../../core/", import.meta.url));

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
}

function readManifest(root: string): PackageManifest {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest;
}

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ? [path]
      : [];
  });
}

function packageImportPattern(packageName: string): RegExp {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = packageName.endsWith("/")
    ? `${escapedPackageName}[^"']+`
    : `${escapedPackageName}(?:/[^"']*)?`;
  return new RegExp(`\\b(?:from\\s*|import\\s*(?:\\(\\s*)?)["']${target}["']`);
}

function packageReferences(root: string, packageName: string): string[] {
  const importPattern = packageImportPattern(packageName);
  return collectSourceFiles(join(root, "src")).flatMap((file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    return lines.flatMap((line, index) =>
      importPattern.test(line) ? [`${relative(root, file)}:${index + 1}`] : [],
    );
  });
}

function declaredPackages(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

describe("mobility package boundaries", () => {
  it("recognizes static, type-only, re-exported, and dynamic package references", () => {
    const pattern = packageImportPattern("@example/package");
    const references = [
      'import value from "@example/package";',
      'import type { Value } from "@example/package/types";',
      'export type { Value } from "@example/package/types";',
      'type Value = import("@example/package/types").Value;',
    ];

    expect(references.every((source) => pattern.test(source))).toBe(true);
    expect(packageImportPattern("@integrations/").test('import "@integrations/example";')).toBe(
      true,
    );
  });

  it("keeps the mobility model below the application core", () => {
    const mobilityManifest = readManifest(MOBILITY_ROOT);
    const coreManifest = readManifest(CORE_ROOT);

    expect(declaredPackages(mobilityManifest)).not.toContain("@openmapx/core");
    expect(declaredPackages(coreManifest)).toContain("@openmapx/mobility-core");
    expect(packageReferences(MOBILITY_ROOT, "@openmapx/core")).toEqual([]);
  });

  it("keeps lower packages independent from the integration layers", () => {
    expect(packageReferences(MOBILITY_ROOT, "@openmapx/integration-framework")).toEqual([]);
    expect(packageReferences(MOBILITY_ROOT, "@integrations/")).toEqual([]);
    expect(packageReferences(CORE_ROOT, "@openmapx/integration-framework")).toEqual([]);
    expect(packageReferences(CORE_ROOT, "@integrations/")).toEqual([]);
  });

  it("keeps the provider-specific RIS client in the server-side mobility layer", () => {
    const mobilityManifest = readManifest(MOBILITY_ROOT);
    const coreManifest = readManifest(CORE_ROOT);

    expect(mobilityManifest.exports?.["./ris-client"]).toBeDefined();
    expect(coreManifest.exports?.["./ris-client"]).toBeUndefined();
    expect(existsSync(join(CORE_ROOT, "src/ris-client.ts"))).toBe(false);
  });
});
