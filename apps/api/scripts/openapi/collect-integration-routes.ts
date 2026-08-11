import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

export interface IntegrationRouteDescriptor {
  /** Integration id, which is also the `/api/integrations/<id>` path segment. */
  integrationId: string;
  method: RouteMethod;
  /** Path as registered with `ctx.registerRoute`, e.g. `/geocode`. */
  routePath: string;
  requireAuth: boolean;
  /** Repo-relative file the registration was read from. */
  sourceFile: string;
}

/**
 * Route-registering helpers that live in the shared framework instead of in an
 * integration. A route registered inside one of these modules belongs to every
 * integration that calls the named factory.
 *
 * `assertNoUnlistedFrameworkRouteSources` fails the generator if a framework
 * module registers a route without being listed here, so adding a new shared
 * factory cannot silently drop routes from the spec.
 */
export const SHARED_ROUTE_FACTORIES = [
  {
    module: join("packages", "integration-framework", "src", "tides-integration-factory.ts"),
    exportName: "createTidesIntegration",
  },
] as const;

const FRAMEWORK_SRC_DIR = join("packages", "integration-framework", "src");
const SKIPPED_INTEGRATION_DIRS = new Set(["_template"]);

function isScannableFile(name: string): boolean {
  return name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts");
}

/** Every scannable `.ts` file under `dir`, sorted, excluding tests and dependencies. */
function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        walk(full);
      } else if (entry.isFile() && isScannableFile(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
}

function forEachCall(source: ts.SourceFile, visit: (node: ts.CallExpression) => void): void {
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) visit(node);
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(source, walk);
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  // A template literal with no substitutions is still a compile-time constant.
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function readRequireAuth(node: ts.Node | undefined): boolean {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    if (name === "requireAuth") return property.initializer.kind === ts.SyntaxKind.TrueKeyword;
  }
  return false;
}

interface RawRegistration {
  method: RouteMethod;
  routePath: string;
  requireAuth: boolean;
  sourceFile: string;
}

/** Reads every `<something>.registerRoute("METHOD", "/path", handler, opts?)` call in a file. */
function readRegistrations(repoRoot: string, file: string): RawRegistration[] {
  const found: RawRegistration[] = [];
  const relativeFile = relative(repoRoot, file).split(sep).join("/");

  forEachCall(parse(file), (call) => {
    if (!ts.isPropertyAccessExpression(call.expression)) return;
    if (call.expression.name.text !== "registerRoute") return;

    const method = literalText(call.arguments[0])?.toUpperCase();
    const routePath = literalText(call.arguments[1]);
    if (!method || !routePath) {
      throw new Error(
        `${relativeFile}: registerRoute() must be called with literal method and path strings ` +
          "so the API surface can be read statically. Rewrite the call or extend the scanner.",
      );
    }
    if (!(ROUTE_METHODS as readonly string[]).includes(method)) {
      throw new Error(`${relativeFile}: unsupported registerRoute method "${method}".`);
    }

    found.push({
      method: method as RouteMethod,
      routePath: routePath.startsWith("/") ? routePath : `/${routePath}`,
      requireAuth: readRequireAuth(call.arguments[3]),
      sourceFile: relativeFile,
    });
  });

  return found;
}

/** True when any file under `dir` calls `exportName(...)`. */
function callsFactory(dir: string, exportName: string): boolean {
  for (const file of listSourceFiles(dir)) {
    let called = false;
    forEachCall(parse(file), (call) => {
      if (ts.isIdentifier(call.expression) && call.expression.text === exportName) called = true;
    });
    if (called) return true;
  }
  return false;
}

/**
 * Fails if a framework module registers routes without being declared in
 * `SHARED_ROUTE_FACTORIES` — such routes would be served but missing from the
 * generated document.
 */
export function assertNoUnlistedFrameworkRouteSources(repoRoot: string): void {
  const declared = new Set<string>(SHARED_ROUTE_FACTORIES.map((factory) => factory.module));
  for (const file of listSourceFiles(join(repoRoot, FRAMEWORK_SRC_DIR))) {
    const relativeFile = relative(repoRoot, file);
    if (declared.has(relativeFile)) continue;
    if (readRegistrations(repoRoot, file).length === 0) continue;
    throw new Error(
      `${relativeFile.split(sep).join("/")} registers integration routes but is not listed in ` +
        "SHARED_ROUTE_FACTORIES (apps/api/scripts/openapi/collect-integration-routes.ts). Add it " +
        "with the exported factory name so its routes are attributed to the integrations that " +
        "call it.",
    );
  }
}

function integrationIdFor(dir: string, dirName: string): string {
  const manifestPath = join(dir, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: unknown };
    return typeof manifest.id === "string" && manifest.id.length > 0 ? manifest.id : dirName;
  } catch {
    return dirName;
  }
}

/**
 * Reads the integration HTTP surface statically, without executing integration
 * code. Integration routes are not Fastify routes — they live in a private
 * registry dispatched from two wildcards — so they cannot be introspected from a
 * running app the way core routes can.
 */
export function collectIntegrationRoutes(repoRoot: string): IntegrationRouteDescriptor[] {
  assertNoUnlistedFrameworkRouteSources(repoRoot);

  const sharedRoutes = SHARED_ROUTE_FACTORIES.filter((factory) =>
    existsSync(join(repoRoot, factory.module)),
  ).map((factory) => ({
    exportName: factory.exportName,
    registrations: readRegistrations(repoRoot, join(repoRoot, factory.module)),
  }));

  const integrationsDir = join(repoRoot, "integrations");
  const dirNames = readdirSync(integrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIPPED_INTEGRATION_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  const descriptors: IntegrationRouteDescriptor[] = [];

  for (const dirName of dirNames) {
    const dir = join(integrationsDir, dirName);
    if (!existsSync(join(dir, "manifest.json"))) continue;
    const integrationId = integrationIdFor(dir, dirName);

    const registrations: RawRegistration[] = [];
    for (const file of listSourceFiles(dir))
      registrations.push(...readRegistrations(repoRoot, file));
    for (const shared of sharedRoutes) {
      if (shared.registrations.length === 0) continue;
      if (callsFactory(dir, shared.exportName)) registrations.push(...shared.registrations);
    }

    for (const registration of registrations) {
      descriptors.push({ integrationId, ...registration });
    }
  }

  return descriptors;
}
