// @vitest-environment node
// Pure filesystem static-analysis guardrail — no DOM. Runs in node even though
// it lives under apps/web (the `web` Vitest project defaults to jsdom, whose
// `import.meta.url` is not a file: URL and breaks fileURLToPath below).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Coverage invariant: any integration that paints a map layer or a panel from
 * its own declared `dataSources` must wire one of the attribution
 * hooks/components, so the source is credited in the UI (MapLibre attribution
 * control for layers, an attribution strip for panels). This is a static
 * source scan — a guardrail that fails loudly when a new map-layer/panel
 * integration ships data without crediting it, rather than a runtime render.
 *
 * If a future integration credits its source through a mechanism not listed in
 * ATTRIBUTION_WIRES, add that symbol here rather than silencing the test.
 */
const INTEGRATIONS_DIR = fileURLToPath(new URL("../../../../integrations", import.meta.url));

const ATTRIBUTION_WIRES = [
  "useIntegrationAttribution",
  "useIntegrationDomainAttribution",
  "useMapAttributions",
  "useAttributionFromHooks",
  "AttributionStrip",
  "SectionAttribution",
  // Shared raster-tile wrapper; it registers its `attributions` prop internally
  // via useMapAttributions, so referencing it counts as wiring.
  "RasterBaseLayer",
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Strip block + line comments (but not the `//` inside a `://` URL) so a symbol
 * mentioned only in a comment — e.g. `// TODO: wire useMapAttributions` — doesn't
 * count as wiring.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const WEB_SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

function mentionsWire(src: string): boolean {
  // Whole-identifier match so a symbol can't slip in as a substring of an
  // unrelated name; the symbols are plain identifiers, safe to embed in RegExp.
  return ATTRIBUTION_WIRES.some((symbol) => new RegExp(`\\b${symbol}\\b`).test(src));
}

/**
 * Files an integration re-exports from the web app via the `@/` alias.
 *
 * An integration whose manifest sets `frontend.sharedMapLayer` renders a layer
 * component owned by the app and shared with sibling providers (street-level-imagery
 * imagery is served by Panoramax, Mapillary and others through one coverage
 * layer). Attribution is wired once, in that shared component, so follow the
 * re-export rather than demanding each integration wire it again — otherwise
 * this guard would push every provider to register duplicate attributions.
 */
function reExportedWebFiles(src: string): string[] {
  const out: string[] = [];
  for (const match of src.matchAll(/from\s+"@\/([^"]+)"/g)) {
    const rel = match[1];
    if (!rel) continue;
    for (const candidate of [`${rel}.tsx`, `${rel}.ts`, `${rel}/index.tsx`, `${rel}/index.ts`]) {
      const full = path.join(WEB_SRC_DIR, candidate);
      if (fs.existsSync(full)) {
        out.push(full);
        break;
      }
    }
  }
  return out;
}

function wiresAttribution(integrationDir: string): boolean {
  return listSourceFiles(integrationDir).some((file) => {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    if (mentionsWire(src)) return true;
    return reExportedWebFiles(src).some((target) =>
      mentionsWire(stripComments(fs.readFileSync(target, "utf8"))),
    );
  });
}

interface Candidate {
  id: string;
  mapLayer: boolean;
  panel: boolean;
}

function collectCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  for (const id of fs.readdirSync(INTEGRATIONS_DIR)) {
    const manifestPath = path.join(INTEGRATIONS_DIR, id, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: { frontend?: { mapLayer?: boolean; panel?: boolean }; dataSources?: unknown[] };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const frontend = manifest.frontend ?? {};
    const hasUi = frontend.mapLayer === true || frontend.panel === true;
    const hasDataSources = (manifest.dataSources ?? []).length > 0;
    if (hasUi && hasDataSources) {
      candidates.push({ id, mapLayer: frontend.mapLayer === true, panel: frontend.panel === true });
    }
  }
  return candidates;
}

describe("attribution-display coverage", () => {
  const candidates = collectCandidates();

  it("finds integrations that render a map layer or panel from their own data sources", () => {
    // If the scan matches nothing (e.g. the integrations dir moved), the
    // coverage assertion below would pass vacuously — fail here instead.
    expect(candidates.length > 0).toBe(true);
  });

  it("every map-layer/panel integration with dataSources wires an attribution hook", () => {
    const unwired = candidates
      .filter((c) => !wiresAttribution(path.join(INTEGRATIONS_DIR, c.id)))
      .map((c) => c.id);

    // On failure the diff prints `unwired` — the integration ids that declare
    // frontend.mapLayer/panel + dataSources but never reference an attribution
    // hook (${ATTRIBUTION_WIRES}). Wire one so their source is credited.
    expect(unwired).toEqual([]);
  });
});
