// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// This guard checks use of a host rendering contract, not receipt correctness.
// Provider/renderer conformance and real-engine tests prove actual ownership.
const INTEGRATIONS_DIR = fileURLToPath(new URL("../../../../integrations", import.meta.url));
const WEB_SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const MAP_WIRES = {
  renderedMapAttributionTracker: "@/integration-api/overlay/renderedMapAttributionTracker",
  useRenderedMapAttributions: "@/integration-api/overlay/useRenderedMapAttributions",
  useRasterMapAttributions: "@/integration-api/overlay/useRasterMapAttributions",
  useMarkerMapAttributions: "@/integration-api/overlay/useMarkerMapAttributions",
  RasterBaseLayer: "@/integration-api/components/RasterBaseLayer",
};
const PANEL_WIRES = {
  AttributionStrip: "@/integration-api/components/AttributionStrip",
};

function sourceTree(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "integration.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function mentionsWire(source: string, wires: Record<string, string> = MAP_WIRES): boolean {
  const tree = sourceTree(source);
  const imported = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const original = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && wires[original] === statement.moduleSpecifier.text)
        imported.add(element.name.text);
    }
  }
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      imported.has(node.expression.text)
    )
      found = true;
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      imported.has(node.tagName.text)
    )
      found = true;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "__tests__", "__fixtures__"].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [full] : [];
  });
}

// Follow shared host components explicitly re-exported by a provider, never
// ordinary imports: importing a hook module does not render its implementation.
function reExportedWebFiles(source: string): string[] {
  return sourceTree(source).statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      return [];
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith("@/integration-api/")) return [];
    const rel = specifier.slice(2);
    for (const candidate of [`${rel}.tsx`, `${rel}.ts`, `${rel}/index.tsx`, `${rel}/index.ts`]) {
      const full = path.join(WEB_SRC_DIR, candidate);
      if (fs.existsSync(full)) return [full];
    }
    return [];
  });
}

function wiresAttribution(dir: string, wires: Record<string, string> = MAP_WIRES): boolean {
  return listSourceFiles(dir).some((file) => {
    const source = fs.readFileSync(file, "utf8");
    return (
      mentionsWire(source, wires) ||
      reExportedWebFiles(source).some((target) =>
        mentionsWire(fs.readFileSync(target, "utf8"), wires),
      )
    );
  });
}

const NO_CREDIT_OWED: Record<string, string> = {
  "overlay-3d-buildings":
    "extrudes the basemap's existing building dataset, already credited by the base style",
  "overlay-cycling":
    "restyles the basemap's existing transportation/poi datasets, already credited by the base style",
  "overlay-tool-measurement": "draws only user-created measurement geometry",
};

interface Candidate {
  id: string;
  hasDataSources: boolean;
  mapLayer: boolean;
  panel: boolean;
}
function collectCandidates(): Candidate[] {
  return fs.readdirSync(INTEGRATIONS_DIR).flatMap((id) => {
    const manifestPath = path.join(INTEGRATIONS_DIR, id, "manifest.json");
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      frontend?: { mapLayer?: boolean; panel?: boolean };
      dataSources?: unknown[];
    };
    const mapLayer = manifest.frontend?.mapLayer === true;
    const panel = manifest.frontend?.panel === true;
    return mapLayer || panel
      ? [{ id, mapLayer, panel, hasDataSources: (manifest.dataSources ?? []).length > 0 }]
      : [];
  });
}

describe("attribution-display coverage", () => {
  const candidates = collectCandidates();
  it("finds declared and borrowed-source renderers", () => {
    expect(candidates.some((c) => c.hasDataSources)).toBe(true);
    expect(candidates.some((c) => !c.hasDataSources)).toBe(true);
  });
  it("every non-exempt map renderer uses captured rendered geometry/raster/DOM ownership", () => {
    const unwired = candidates
      .filter((c) => c.mapLayer && !(c.id in NO_CREDIT_OWED))
      .filter((c) => !wiresAttribution(path.join(INTEGRATIONS_DIR, c.id)))
      .map((c) => c.id);
    expect(unwired).toEqual([]);
  });
  it("every panel renders its own displayed-record receipts", () => {
    const unwired = candidates
      .filter((c) => c.panel && !(c.id in NO_CREDIT_OWED))
      .filter((c) => !wiresAttribution(path.join(INTEGRATIONS_DIR, c.id), PANEL_WIRES))
      .map((c) => c.id);
    expect(unwired).toEqual([]);
  });
  it("keeps documented no-credit exemptions restricted to source-free renderers", () => {
    expect(
      Object.keys(NO_CREDIT_OWED).filter(
        (id) => !candidates.some((c) => c.id === id && !c.hasDataSources),
      ),
    ).toEqual([]);
  });
});

describe("navigation host attribution wiring", () => {
  it.each(["RouteSearchResultsLayer.tsx", "ArrivalParkingMarkers.tsx"])(
    "owns displayed receipts in %s",
    (filename) => {
      const source = fs.readFileSync(
        path.join(WEB_SRC_DIR, "components/navigation", filename),
        "utf8",
      );
      expect(mentionsWire(source)).toBe(true);
    },
  );
});

describe("attribution wiring guard conformance", () => {
  it("ignores test-only wiring in an otherwise uncredited renderer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attribution-wiring-"));
    try {
      fs.writeFileSync(
        path.join(dir, "map-layer.tsx"),
        "export default function MapLayer() { return null; }",
      );
      fs.writeFileSync(
        path.join(dir, "map-layer.test.tsx"),
        'import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions"; useRenderedMapAttributions("test", [], true);',
      );
      expect(wiresAttribution(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a locally defined hook with the same name as the host contract", () => {
    expect(
      mentionsWire("function useRenderedMapAttributions() {} useRenderedMapAttributions();"),
    ).toBe(false);
  });

  it("follows a renamed imported host hook", () => {
    expect(
      mentionsWire(
        'import { useRenderedMapAttributions as rendered } from "@/integration-api/overlay/useRenderedMapAttributions"; rendered("map", ["points"], true);',
      ),
    ).toBe(true);
  });
  it.each([
    'useIntegrationAttribution("supplier", enabled);',
    'useIntegrationDomainAttribution("transit", enabled);',
    'useSourceAttributions("overlay", sourceIds);',
    'useMapAttributions("overlay", enabled ? manifestCredits : []);',
    "useAttributionFromHooks(hooks, enabled);",
  ])("does not accept toggle/catalogue-only map wiring: %s", (source) => {
    expect(mentionsWire(source)).toBe(false);
  });

  it.each([
    'import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";',
    'const todo = "useRenderedMapAttributions";',
    '// TODO useRenderedMapAttributions("overlay", layers, enabled);',
    "function useRenderedMapAttributions() {}",
  ])("requires an actual rendering registration, rather than a mention: %s", (source) => {
    expect(mentionsWire(source)).toBe(false);
  });

  it.each([
    'useRenderedMapAttributions("overlay", ["points"], enabled);',
    'useRasterMapAttributions("overlay", descriptors, enabled);',
    'useMarkerMapAttributions("overlay", element, contributors, enabled);',
    "<RasterBaseLayer attributions={captured} />",
  ])("accepts rendered geometry/raster/DOM ownership: %s", (source) => {
    const symbol = source.startsWith("<")
      ? "RasterBaseLayer"
      : source.slice(0, source.indexOf("("));
    const imported = `import { ${symbol} } from "${MAP_WIRES[symbol as keyof typeof MAP_WIRES]}";`;
    expect(mentionsWire(`${imported}\n${source}`)).toBe(true);
  });
});
