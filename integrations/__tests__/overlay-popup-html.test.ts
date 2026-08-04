import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INTEGRATIONS_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * MapLibre's Popup.setHTML assigns to innerHTML. A popup assembled from feed
 * data therefore needs an escaping or trusted-card builder in the same file,
 * and an interpolated anchor URL needs scheme validation before it is emitted.
 * This static guard keeps new overlay popups from silently reopening either
 * injection path.
 */

const EXEMPT = new Set<string>();
const SAFE_POPUP_HELPERS = [
  "escapeHtml",
  "buildPopupCard",
  "buildStackedPopupCard",
  // This builder delegates to buildStackedPopupCardItems in its own module.
  "buildRoadConditionPopupHtml",
];

function collectTsxFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTsxFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) files.push(full);
  }
  return files;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function hasImportedHelper(source: string): boolean {
  const importBlock = source.match(/import[\s\S]*?from\s+["'][^"']+["'];/g) ?? [];
  return importBlock.some((statement) =>
    SAFE_POPUP_HELPERS.some((helper) => new RegExp(`\\b${helper}\\b`).test(statement)),
  );
}

function hasSanitizedBinding(source: string, expression: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return false;
  return new RegExp(
    `\\b(?:const|let|var)\\s+${expression}\\s*=.{0,240}?sanitizeUrl\\s*\\(`,
    "s",
  ).test(source);
}

function findPopupImportOffenders(files: string[]): string[] {
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    if (EXEMPT.has(path.relative(INTEGRATIONS_DIR, file))) return [];
    if (!source.includes(".setHTML(") || hasImportedHelper(source)) return [];
    return [
      `${path.relative(INTEGRATIONS_DIR, file)}:${lineNumber(source, source.indexOf(".setHTML("))}`,
    ];
  });
}

function findUnsafeAnchorOffenders(files: string[]): string[] {
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    if (EXEMPT.has(path.relative(INTEGRATIONS_DIR, file))) return [];
    const offenders: string[] = [];
    for (const match of source.matchAll(/href="\$\{([^}]*)\}/g)) {
      const expression = match[1].trim();
      if (expression.startsWith("sanitizeUrl(") || hasSanitizedBinding(source, expression))
        continue;
      offenders.push(
        `${path.relative(INTEGRATIONS_DIR, file)}:${lineNumber(source, match.index ?? 0)}`,
      );
    }
    return offenders;
  });
}

describe("integration popup HTML safety", () => {
  const files = collectTsxFiles(INTEGRATIONS_DIR);

  it("scans the integration TSX tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("every Popup.setHTML file imports an escaping or trusted-card helper", () => {
    const offenders = findPopupImportOffenders(files);
    expect(
      offenders,
      `Popup.setHTML files without an approved helper (MapLibre assigns the value to innerHTML):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every interpolated popup href is scheme-checked", () => {
    const offenders = findUnsafeAnchorOffenders(files);
    expect(
      offenders,
      `Interpolated popup href values must use sanitizeUrl or a binding initialized by sanitizeUrl:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
