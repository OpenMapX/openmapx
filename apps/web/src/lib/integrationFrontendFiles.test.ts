// @vitest-environment node
// Pure filesystem static-analysis guardrail — no DOM. Runs in node even though
// it lives under apps/web (the `web` Vitest project defaults to jsdom, whose
// `import.meta.url` is not a file: URL and breaks fileURLToPath below).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const INTEGRATIONS_DIR = fileURLToPath(new URL("../../../../integrations", import.meta.url));
const WEB_SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

const FRONTEND_SOURCE_EXTENSIONS = [".tsx", ".ts"] as const;
const APP_PACKAGE_IMPORTS = ["@openmapx/web", "openmapx-web", "apps/web", "web/src", "src"];

type ImportBoundaryViolation = {
  file: string;
  specifier: string;
  reason: string;
};

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") pending.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

function isIgnoredFrontendSource(file: string): boolean {
  const relative = path.relative(INTEGRATIONS_DIR, file);
  return (
    relative.startsWith(`_placeholder${path.sep}`) ||
    relative.split(path.sep).some((part) => part === "__tests__" || part === "__fixtures__") ||
    /\.(?:test|spec|fixture|fixtures|stories)\.[cm]?[jt]sx?$/.test(relative)
  );
}

function productionFrontendRoots(): string[] {
  return filesUnder(INTEGRATIONS_DIR).filter(
    (file) => file.endsWith(".tsx") && !isIgnoredFrontendSource(file),
  );
}

function moduleSpecifiers(file: string, source: string): string[] {
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers: string[] = [];

  const callSpecifier = (argument: ts.Expression): string | null => {
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      return argument.text;
    }
    if (!ts.isTemplateExpression(argument)) return null;
    return `${argument.head.text}${argument.templateSpans
      .map((span) => `\${expression}${span.literal.text}`)
      .join("")}`;
  };

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier = callSpecifier(node.arguments[0]);
      if (specifier) specifiers.push(specifier);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function resolveRelativeModule(importer: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    ...FRONTEND_SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...FRONTEND_SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ??
    null
  );
}

function boundaryViolation(
  importer: string,
  specifier: string,
): Omit<ImportBoundaryViolation, "file" | "specifier"> | null {
  if (specifier === "@/integration-api" || specifier.startsWith("@/integration-api/")) {
    if (!/^@\/integration-api\/(?:map|overlay|runtime|components)\/[^/]+/.test(specifier)) {
      return { reason: "integration API imports require a focused group and module subpath" };
    }
    return null;
  }
  if (specifier.startsWith("@/")) {
    return { reason: "integration frontend imports a private web module" };
  }
  if (
    APP_PACKAGE_IMPORTS.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))
  ) {
    return { reason: "integration frontend disguises a web-app import as a package import" };
  }
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(importer), specifier);
    const relativeToWeb = path.relative(WEB_SRC_DIR, target);
    if (
      relativeToWeb === "" ||
      (!relativeToWeb.startsWith("..") && !path.isAbsolute(relativeToWeb))
    ) {
      return { reason: "integration frontend reaches the web app through a relative import" };
    }
  }
  return null;
}

function scanFrontendImports(roots: readonly string[]): {
  scannedFiles: string[];
  violations: ImportBoundaryViolation[];
} {
  const pending = [...roots];
  const scannedFiles = new Set<string>();
  const violations: ImportBoundaryViolation[] = [];

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || scannedFiles.has(file) || isIgnoredFrontendSource(file)) continue;
    scannedFiles.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of moduleSpecifiers(file, source)) {
      const violation = boundaryViolation(file, specifier);
      if (violation) {
        violations.push({ file: path.relative(INTEGRATIONS_DIR, file), specifier, ...violation });
      }
      if (!specifier.startsWith(".")) continue;
      const dependency = resolveRelativeModule(file, specifier);
      if (dependency?.startsWith(`${INTEGRATIONS_DIR}${path.sep}`)) pending.push(dependency);
    }
  }

  return {
    scannedFiles: [...scannedFiles].sort(),
    violations: violations.sort((a, b) =>
      `${a.file}:${a.specifier}`.localeCompare(`${b.file}:${b.specifier}`),
    ),
  };
}

function integrationApiSources(): string[] {
  const root = path.join(WEB_SRC_DIR, "integration-api");
  return filesUnder(root).filter(
    (file) =>
      /\.[cm]?[jt]sx?$/.test(file) &&
      !/\.(?:test|spec|fixture|fixtures|stories)\.[cm]?[jt]sx?$/.test(file),
  );
}

function isDynamicIntegrationEntry(specifier: string): boolean {
  return (
    specifier.startsWith("@integrations/") ||
    /(?:^|\/)(?:MapLayerHost|LegendHost|PanelHost|crowdReportsLazy)(?:\.[cm]?[jt]sx?)?$/.test(
      specifier,
    )
  );
}

/**
 * `frontend.<flag>` in a manifest makes the host lazily `import()` a matching
 * module. A missing file is invisible to tsc, the bundler and the test suite —
 * it only surfaces as a rejected dynamic import that React `lazy` rethrows at
 * render time, taking the page with it. Assert the files exist.
 */
const REQUIRED_FILES: Array<{ flag: "mapLayer" | "legend" | "panel"; basename: string }> = [
  { flag: "mapLayer", basename: "map-layer" },
  { flag: "legend", basename: "legend" },
  { flag: "panel", basename: "panel" },
];

interface Manifest {
  frontend?: Record<string, unknown>;
}

function readManifest(dir: string): Manifest | null {
  const manifestPath = path.join(INTEGRATIONS_DIR, dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function modulePath(dir: string, basename: string): string | null {
  for (const ext of [".tsx", ".ts"]) {
    const full = path.join(INTEGRATIONS_DIR, dir, `${basename}${ext}`);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * The hosts resolve a component as `mod.default ?? first function-valued
 * export`, so a module that exists but exports nothing renders `undefined` and
 * crashes exactly like a missing file. This is a static approximation — it
 * cannot tell a function export from a constant — but it catches empty and
 * stub modules, which is the realistic failure.
 */
function exportsSomething(file: string): boolean {
  return /^\s*export\s/m.test(fs.readFileSync(file, "utf8"));
}

describe("integration frontend modules", () => {
  const dirs = fs
    .readdirSync(INTEGRATIONS_DIR)
    .filter((dir) => readManifest(dir) !== null)
    .sort();

  it("finds integration manifests to check", () => {
    // Guard against a vacuous pass if the integrations dir ever moves.
    expect(dirs.length).toBeGreaterThan(0);
  });

  it("every manifest frontend flag has the module the host will import", () => {
    const missing: string[] = [];

    for (const dir of dirs) {
      const frontend = readManifest(dir)?.frontend;
      if (!frontend) continue;

      for (const { flag, basename } of REQUIRED_FILES) {
        if (frontend[flag] !== true) continue;

        const file = modulePath(dir, basename);
        if (!file) {
          missing.push(`${dir}: frontend.${flag} is true but ${basename}.tsx is missing`);
        } else if (!exportsSomething(file)) {
          missing.push(`${dir}: ${basename} exists but exports nothing the host can render`);
        }
      }
    }

    // On failure the diff lists each manifest promising a module it doesn't
    // ship. Either add the file (re-exporting a shared component is fine) or
    // drop the flag.
    expect(missing).toEqual([]);
  });

  it("assigns the air-quality overlay to exactly one canonical frontend owner", () => {
    const owners = ["air-quality", "overlay-air-quality"].filter((id) => {
      const frontend = readManifest(id)?.frontend;
      return Boolean(
        frontend?.mapLayer === true ||
          frontend?.legend === true ||
          frontend?.layerSelector ||
          frontend?.overlay,
      );
    });

    expect(owners).toEqual(["air-quality"]);
  });

  it("scans every production frontend source while deliberately ignoring tests and fixtures", () => {
    const roots = productionFrontendRoots();
    const { scannedFiles } = scanFrontendImports(roots);

    expect(roots.length).toBeGreaterThan(50);
    expect(roots).toContain(
      path.join(INTEGRATIONS_DIR, "overlay-wildfires/layers/hotspot-layer.tsx"),
    );
    expect(roots.every((root) => scannedFiles.includes(root))).toBe(true);
    expect(
      isIgnoredFrontendSource(path.join(INTEGRATIONS_DIR, "air-quality/map-layer.test.tsx")),
    ).toBe(true);
    expect(
      isIgnoredFrontendSource(path.join(INTEGRATIONS_DIR, "air-quality/__fixtures__/layer.tsx")),
    ).toBe(true);
    expect(isIgnoredFrontendSource(path.join(INTEGRATIONS_DIR, "_placeholder/panel.tsx"))).toBe(
      true,
    );
  });

  it("rejects every route around the focused integration API boundary", () => {
    const importer = path.join(INTEGRATIONS_DIR, "example/map-layer.tsx");
    expect(boundaryViolation(importer, "@/lib/private")?.reason).toContain("private web");
    expect(boundaryViolation(importer, "../../apps/web/src/lib/MapContext")?.reason).toContain(
      "relative import",
    );
    expect(boundaryViolation(importer, "@openmapx/web/lib/MapContext")?.reason).toContain(
      "package import",
    );
    expect(boundaryViolation(importer, "@/integration-api")?.reason).toContain("focused");
    expect(boundaryViolation(importer, "@/integration-api/map")?.reason).toContain("focused");
    expect(boundaryViolation(importer, "@/integration-api/map/context")).toBeNull();
    const interpolation = "${";
    expect(
      moduleSpecifiers(
        importer,
        `const entry = import(\`@integrations/${interpolation}id}/map-layer\`);`,
      ),
    ).toEqual([`@integrations/${interpolation}expression}/map-layer`]);
  });

  it("keeps production integration frontends on the focused integration API", () => {
    const { violations } = scanFrontendImports(productionFrontendRoots());
    expect(violations).toEqual([]);
  });

  it("keeps the integration API independent from dynamic integration entry points", () => {
    const files = integrationApiSources();
    const violations = files.flatMap((file) =>
      moduleSpecifiers(file, fs.readFileSync(file, "utf8"))
        .filter(isDynamicIntegrationEntry)
        .map((specifier) => `${path.relative(WEB_SRC_DIR, file)}: ${specifier}`),
    );

    expect(files.length).toBeGreaterThan(0);
    expect(isDynamicIntegrationEntry("@/components/map/MapLayerHost")).toBe(true);
    expect(isDynamicIntegrationEntry("@integrations/example/map-layer")).toBe(true);
    expect(violations).toEqual([]);
  });
});
