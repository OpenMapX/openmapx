// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

// These values are code-built URLs, module constants, internal route strings,
// or in-repo legal/notice data. Runtime third-party URLs must use safeHref.
// CredentialSetupGuide and PlaceAirportInfo sanitize their values in a helper
// before the JSX binding; IntegrationDetail sanitizes DpaChip's local binding.
const ALLOWED: Record<string, string[]> = {
  "app/(legal)/LegalTabBar.tsx": ["p.href"],
  "app/(legal)/privacy/content.en.tsx": [
    "email.privacyUrl",
    "supervisoryAuthorityUrl",
    "row.privacy",
  ],
  "app/(legal)/privacy/content.de.tsx": [
    "email.privacyUrl",
    "supervisoryAuthorityUrl",
    "row.privacy",
  ],
  "app/(legal)/terms/content.en.tsx": ["row.url", "row.licenseUrl"],
  "app/(legal)/terms/content.de.tsx": ["row.url", "row.licenseUrl"],
  "app/(legal)/licenses/page.tsx": ["notice.licenseUrl", "notice.projectUrl"],
  "components/admin/AdminSidebar.tsx": ["item.href"],
  "components/admin/AdminTopBar.tsx": ["crumb.href"],
  "components/admin/shared/AdminPageHeader.tsx": ["backHref"],
  "components/admin/shared/CompactAlertList.tsx": ["item.href"],
  "components/admin/overview/AdminOverview.tsx": ["href"],
  "components/auth/MangroveAccountSection.tsx": ["MANGROVE_HOME_URL"],
  "components/panels/place/reviews/WriteReviewDialog.tsx": [
    "MANGROVE_HOME_URL",
    "MANGROVE_TERMS_URL",
    "MANGROVE_PRIVACY_URL",
    "LICENSE_URLS[license]",
  ],
  "components/panels/place/PlaceOverviewTab.tsx": ["plusCodeUrl(plusCode)"],
  // Both bindings are `safeHref(...)` results, held in a const so the button is
  // rendered only when sanitization actually returned a URL.
  "components/panels/place/contributions/OsmContributionGate.tsx": ["messagesHref", "termsHref"],
  "components/admin/integrations/CredentialSetupGuide.tsx": ["url", "buildMailto(setup.email)"],
  "components/panels/place/PlaceAirportInfo.tsx": ["airport.homeLink", "ourAirportsUrl"],
  "components/panels/place/DataSourceSections.tsx": ["rentalUri"],
  "components/admin/integrations/IntegrationDetail.tsx": ["href", "privacyHref"],
  "components/ui/AttributionStrip.tsx": ["link.href"],
};

function collectTsxFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTsxFiles(full));
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) files.push(full);
  }
  return files;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function readExpression(source: string, openBrace: number): string | undefined {
  let depth = 1;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let index = openBrace + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index).trim();
    }
  }
  return undefined;
}

function findUnsafeHrefs(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(SRC_DIR, file);
  const allowed = new Set(ALLOWED[relative] ?? []);
  const offenders: string[] = [];

  for (const match of source.matchAll(/href=\{/g)) {
    const expression = readExpression(source, (match.index ?? 0) + "href=".length);
    if (!expression) continue;
    if (
      expression.startsWith("safeHref(") ||
      expression.startsWith('"') ||
      expression.startsWith("'") ||
      expression.startsWith("`") ||
      allowed.has(expression)
    ) {
      continue;
    }
    offenders.push(`${relative}:${lineNumber(source, match.index ?? 0)} — ${expression}`);
  }
  return offenders;
}

describe("JSX href sanitization coverage", () => {
  const files = collectTsxFiles(SRC_DIR);

  it("scans the web source tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("guards every runtime URL passed through JSX href", () => {
    const offenders = files.flatMap(findUnsafeHrefs);
    expect(offenders).toEqual([]);
  });
});
