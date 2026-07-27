// @vitest-environment node
// Pure filesystem static-analysis guardrail — no DOM. Runs in node even though
// it lives under apps/web (the `web` Vitest project defaults to jsdom, whose
// `import.meta.url` is not a file: URL and breaks fileURLToPath below).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Coverage invariant: any integration that paints a map layer or a panel must
 * wire one of the attribution hooks/components, so whatever it renders is
 * credited in the UI (the map credits strip for layers, an attribution strip
 * for panels). This is a static source scan — a guardrail that fails loudly
 * when a new map-layer/panel integration ships data without crediting it,
 * rather than a runtime render.
 *
 * It applies whether the credits are the integration's own (`dataSources` on
 * its manifest), a sibling's (a domain aggregate) or the response's (a runtime
 * envelope); only the documented NO_CREDIT_OWED exemptions are out of scope.
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

/**
 * Integrations that render UI, declare no `dataSources`, and legitimately owe
 * no credit of their own — so the "wire an attribution hook" rule does not
 * apply to them. Every entry needs a reason; anything else with an empty
 * `dataSources` list is either aggregating a sibling's credits (wire
 * `useIntegrationDomainAttribution`) or crediting a runtime envelope (wire
 * `useMapAttributions`), and the test below says so.
 *
 * The empty-dataSources case is the one the original scan skipped entirely:
 * overlay-traffic-flow, overlay-live-transit and overlay-transit paint
 * third-party data through a domain/runtime credit, and dropping that call
 * used to fail nothing.
 */
const NO_CREDIT_OWED: Record<string, string> = {
  "overlay-3d-buildings":
    "extrudes the basemap's own `building` source-layer; the base style's credits already cover it",
  "overlay-cycling":
    "restyles the basemap's own `transportation`/`poi` source-layers; the base style's credits already cover it",
  "overlay-tool-measurement": "draws only the user's own measurement geometry — no external data",
};

interface Candidate {
  id: string;
  hasDataSources: boolean;
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
    if (!hasUi) continue;
    candidates.push({ id, hasDataSources: (manifest.dataSources ?? []).length > 0 });
  }
  return candidates;
}

describe("attribution-display coverage", () => {
  const candidates = collectCandidates();
  const owning = candidates.filter((c) => c.hasDataSources);
  const borrowing = candidates.filter((c) => !c.hasDataSources);

  it("finds integrations that render a map layer or panel", () => {
    // If the scan matches nothing (e.g. the integrations dir moved), the
    // coverage assertions below would pass vacuously — fail here instead.
    expect(owning.length > 0).toBe(true);
    expect(borrowing.length > 0).toBe(true);
  });

  it("every map-layer/panel integration with dataSources wires an attribution hook", () => {
    const unwired = owning
      .filter((c) => !wiresAttribution(path.join(INTEGRATIONS_DIR, c.id)))
      .map((c) => c.id);

    // On failure the diff prints `unwired` — the integration ids that declare
    // frontend.mapLayer/panel + dataSources but never reference an attribution
    // hook (${ATTRIBUTION_WIRES}). Wire one so their source is credited.
    expect(unwired).toEqual([]);
  });

  it("every map-layer/panel integration without dataSources credits a sibling or is exempt", () => {
    const unwired = borrowing
      .filter((c) => !(c.id in NO_CREDIT_OWED))
      .filter((c) => !wiresAttribution(path.join(INTEGRATIONS_DIR, c.id)))
      .map((c) => c.id);

    // On failure the diff prints `unwired` — integrations that paint UI while
    // declaring no data sources of their own and crediting nobody else's.
    // Either wire `useIntegrationDomainAttribution` (credits go to the sibling
    // integrations publishing the feeds) or `useMapAttributions` (credits ride
    // along on the response), or add the id to NO_CREDIT_OWED with a reason.
    expect(unwired).toEqual([]);
  });

  it("keeps the NO_CREDIT_OWED exemptions honest", () => {
    // A stale exemption is worse than none: it would silently excuse an
    // integration that has since grown its own data sources.
    const stale = Object.keys(NO_CREDIT_OWED).filter((id) => !borrowing.some((c) => c.id === id));
    expect(stale).toEqual([]);
  });
});
