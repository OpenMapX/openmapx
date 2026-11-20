/**
 * Provider HTTP path gate.
 *
 * Server-side integration code and the shared provider packages choose one of
 * three HTTP paths (see "Choosing the HTTP path" in
 * docs/docs/developer/integration-system.md): the host `HttpClient` for
 * credentialed, quota-bound, binary or tile requests; `fetchJson` for public,
 * unkeyed JSON from a fixed host; `safeFetch*` when the URL comes from data or
 * configuration. This gate refuses three things in that code:
 *
 * 1. Raw `fetch`, called or passed on as a value. It bypasses the host's
 *    timeouts, byte ceilings, redirect rules and test seam.
 * 2. `fetchJson` in a module that reads a credential (a secret, a key or token
 *    name, or an authorization or key header). A credentialed request needs the
 *    host client's status errors and redirect rule. `safeFetch*` stays allowed:
 *    it is the SSRF boundary for URLs that come from data, keyed or not.
 * 3. A coordinate that falls back to zero (`lat ?? 0`), which places a record
 *    at 0° N 0° E instead of rejecting it.
 *
 * Integration code is the server module graph: each integration's `index.ts`
 * and its `.ts` package exports, followed through relative imports. Browser
 * modules that call the app's own API are not part of it. Each exception names
 * the exact number of findings in one file and the reason they are acceptable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS = "integrations";
/** Shared provider packages scanned in full. */
const PACKAGE_ROOTS = [
  "packages/integration-framework/src",
  "packages/mobility-core/src",
  "packages/noaa-coops-data",
  "packages/ourairports-data",
  "packages/entur-client/src",
  "packages/otp-client/src",
];
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "__tests__",
  "__fixtures__",
  "testing",
  "scripts",
]);

export type ProviderHttpRule = "raw-fetch" | "credentialed-fetch-json" | "null-island";

export interface ProviderHttpException {
  /** How many findings of this rule the file holds; any other number fails the gate. */
  readonly count: number;
  readonly reason: string;
}

export type ProviderHttpExceptions = Readonly<
  Record<ProviderHttpRule, Readonly<Record<string, ProviderHttpException>>>
>;

/** Reason shared by the sites the credentialed-provider migration removes next. */
const MOVES_TO_HOST_CLIENT =
  "Credentialed provider still on its own request path; it moves to ctx.http with the credentialed-provider migration.";
const NULL_ISLAND_PENDING =
  "Payload validation for this provider replaces the zero fallback with a rejected or omitted record.";

export const EXCEPTIONS: ProviderHttpExceptions = {
  "raw-fetch": {
    "integrations/geocoding-motis/provider.ts": {
      count: 1,
      reason: "Readiness probe of the operator's local MOTIS instance, not a provider request.",
    },
    "integrations/search-nlp/index.ts": {
      count: 1,
      reason:
        "Asks the local Ollama service to pull a model; the pull deliberately has no duration bound.",
    },
    "integrations/overlay-nautical/stations.ts": {
      count: 1,
      reason:
        "The Kartverket station list moves into the shared tide catalogs, read through ctx.http.",
    },
    "integrations/transit-mobility-database/client.ts": {
      count: 1,
      reason: MOVES_TO_HOST_CLIENT,
    },
  },
  "credentialed-fetch-json": {
    "integrations/photos-flickr/provider.ts": { count: 1, reason: MOVES_TO_HOST_CLIENT },
    "integrations/routing-valhalla/provider.ts": { count: 6, reason: MOVES_TO_HOST_CLIENT },
    "integrations/street-level-imagery-mapillary/provider.ts": {
      count: 4,
      reason: MOVES_TO_HOST_CLIENT,
    },
    "integrations/transit-dynamic-registry/fetcher.ts": { count: 3, reason: MOVES_TO_HOST_CLIENT },
    "integrations/transit-tfl/provider.ts": { count: 1, reason: MOVES_TO_HOST_CLIENT },
    "integrations/transit-transitland/provider.ts": { count: 1, reason: MOVES_TO_HOST_CLIENT },
    "integrations/weather-openweathermap/index.ts": { count: 1, reason: MOVES_TO_HOST_CLIENT },
  },
  "null-island": {
    "integrations/overlay-air-quality/station-demand.ts": { count: 2, reason: NULL_ISLAND_PENDING },
    "integrations/routing-valhalla/provider.ts": { count: 2, reason: NULL_ISLAND_PENDING },
    "integrations/transit-dynamic-registry/hafas-mgate.ts": {
      count: 6,
      reason: NULL_ISLAND_PENDING,
    },
    "integrations/transit-entur/provider.ts": { count: 4, reason: NULL_ISLAND_PENDING },
    "integrations/transit-motis/adapter.ts": { count: 14, reason: NULL_ISLAND_PENDING },
    "integrations/transit-opentransportdata-ch/provider.ts": {
      count: 4,
      reason: NULL_ISLAND_PENDING,
    },
    "integrations/transit-ris-routing/provider.ts": { count: 2, reason: NULL_ISLAND_PENDING },
  },
};

export interface ProviderHttpFinding {
  readonly rule: ProviderHttpRule;
  readonly line: number;
  readonly text: string;
}

/** `lat`, `latitude`, `fromLat`, `lat_e7` or `lngDeg`, but not `latency` or `longest`. */
const COORDINATE_NAME =
  /^(?:lat|lng|lon|latitude|longitude)(?:[A-Z_\d]\w*)?$|[a-z\d_](?:Lat|Lng|Lon|Latitude|Longitude)(?:[A-Z_\d]\w*)?$/;
const CREDENTIAL_NAME =
  /^(?:\w*api_?key|app_?key|appid|\w*access_?token|client_?secret|authorization)$/i;
/** camelCase names such as `githubToken`; plain `token` is too common in text processing. */
const CREDENTIAL_TOKEN_NAME = /^[a-z][a-zA-Z0-9]*Token$/;
const CREDENTIAL_STRING = /^(?:authorization|x-api-key|[\w-]*api[-_]?key|app_?key|appid)$/i;
const GLOBAL_RECEIVERS = new Set(["globalThis", "window", "self", "global"]);

function lastName(expression: ts.Expression): string | undefined {
  let inner = expression;
  while (
    ts.isNonNullExpression(inner) ||
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner)
  ) {
    inner = inner.expression;
  }
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteral(inner.argumentExpression)) {
    return inner.argumentExpression.text;
  }
  return undefined;
}

/** True when an identifier named `fetch` refers to the global, not to a declaration or property. */
function isGlobalFetchReference(
  node: ts.Identifier,
  shadowingScopes: ReadonlySet<ts.Node>,
): boolean {
  if (node.text !== "fetch") return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isParameter(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) return false;
  for (let scope: ts.Node | undefined = parent; scope; scope = scope.parent) {
    if (shadowingScopes.has(scope)) return false;
  }
  return true;
}

function isBlockScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isFunctionLike(node)
  );
}

/** The node whose subtree a declaration named `fetch` shadows the global in. */
function scopeOfDeclaration(declaration: ts.Node): ts.Node | undefined {
  let node: ts.Node = declaration;
  // A parameter, or a binding element inside one, shadows within its function.
  while (
    ts.isBindingElement(node) ||
    ts.isObjectBindingPattern(node) ||
    ts.isArrayBindingPattern(node)
  ) {
    node = node.parent;
  }
  if (ts.isParameter(node)) return node.parent;
  const functionScoped =
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.BlockScoped) === 0;
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (functionScoped ? ts.isFunctionLike(scope) || ts.isSourceFile(scope) : isBlockScope(scope)) {
      return scope;
    }
  }
  return undefined;
}

/** Scopes in which the module declares its own binding named `fetch`. */
function fetchShadowingScopes(source: ts.SourceFile): Set<ts.Node> {
  const scopes = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isImportSpecifier(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === "fetch"
    ) {
      const scope = ts.isImportSpecifier(node) ? source : scopeOfDeclaration(node);
      if (scope) scopes.add(scope);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scopes;
}

/** True when the module reads a credential: a secret, a key or token name, or a key header. */
export function readsCredential(source: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "secrets") found = true;
    else if (
      ts.isIdentifier(node) &&
      (CREDENTIAL_NAME.test(node.text) || CREDENTIAL_TOKEN_NAME.test(node.text))
    ) {
      found = true;
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      CREDENTIAL_STRING.test(node.text)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** `fetchJson` and the shared wrappers around it. */
const FETCH_JSON_HELPERS: ReadonlyArray<{ module: string; name: string }> = [
  { module: "@openmapx/core", name: "fetchJson" },
  { module: "@openmapx/integration-weather/lib", name: "fetchJsonWithTimeout" },
];

/** Local names bound to `fetchJson` or a wrapper around it by an import. */
function fetchJsonNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (
        FETCH_JSON_HELPERS.some((helper) => helper.module === module && helper.name === imported)
      ) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/** Every finding of the three rules in one module. */
export function findProviderHttpFindings(
  sourceText: string,
  fileName: string,
): ProviderHttpFinding[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const shadowingScopes = fetchShadowingScopes(source);
  const fetchJson = fetchJsonNames(source);
  const credentialed = fetchJson.size > 0 && readsCredential(source);
  const findings: ProviderHttpFinding[] = [];
  const record = (rule: ProviderHttpRule, node: ts.Node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ rule, line: line + 1, text: node.getText(source).split("\n")[0] as string });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isGlobalFetchReference(node, shadowingScopes)) {
      record("raw-fetch", node.parent);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "fetch" &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_RECEIVERS.has(node.expression.text)
    ) {
      record("raw-fetch", node);
    }
    if (
      credentialed &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      fetchJson.has(node.expression.text)
    ) {
      record("credentialed-fetch-json", node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isNumericLiteral(node.right) &&
      Number(node.right.text) === 0
    ) {
      let operand = node.left;
      while (
        ts.isBinaryExpression(operand) &&
        operand.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        operand = operand.right;
      }
      const name = lastName(operand);
      if (name !== undefined && COORDINATE_NAME.test(name)) record("null-island", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function isProductionModule(name: string): boolean {
  return (
    /\.(?:ts|mts)$/.test(name) &&
    !name.endsWith(".d.ts") &&
    !/\.(?:test|spec)\.(?:ts|mts)$/.test(name)
  );
}

function listModules(directory: string): string[] {
  const modules: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) modules.push(...listModules(path));
    } else if (entry.isFile() && isProductionModule(entry.name)) {
      modules.push(path);
    }
  }
  return modules;
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const withoutJs = base.replace(/\.(?:js|mjs)$/, "");
  for (const candidate of [
    base,
    `${withoutJs}.ts`,
    `${withoutJs}.mts`,
    join(withoutJs, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && isProductionModule(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function relativeImports(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) &&
      !(ts.isExportDeclaration(node) && node.isTypeOnly)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolveRelative(path, specifier))
    .filter((resolved): resolved is string => resolved !== undefined);
}

function exportedEntries(packageJson: string): string[] {
  const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { exports?: unknown };
  const entries: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") entries.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(manifest.exports);
  return entries;
}

/** The server module graph of every integration. */
function integrationServerModules(): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const entry of readdirSync(join(ROOT, INTEGRATIONS), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name === "__tests__") continue;
    const directory = join(ROOT, INTEGRATIONS, entry.name);
    const starts = [join(directory, "index.ts")];
    const packageJson = join(directory, "package.json");
    if (existsSync(packageJson)) {
      starts.push(...exportedEntries(packageJson).map((path) => join(directory, path)));
    }
    for (const start of starts) {
      if (existsSync(start) && isProductionModule(start)) queue.push(resolve(start));
    }
  }
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const next of relativeImports(path, readFileSync(path, "utf8"))) {
      if (!next.split(sep).some((part) => SKIPPED_DIRECTORIES.has(part))) queue.push(next);
    }
  }
  return [...seen];
}

export function checkProviderHttp(
  modules: ReadonlyMap<string, string>,
  exceptions: ProviderHttpExceptions = EXCEPTIONS,
): string[] {
  const failures: string[] = [];
  const counts = new Map<string, ProviderHttpFinding[]>();
  for (const [path, text] of modules) {
    for (const finding of findProviderHttpFindings(text, path)) {
      const key = `${finding.rule}\0${path}`;
      counts.set(key, [...(counts.get(key) ?? []), finding]);
    }
  }
  const advice: Record<ProviderHttpRule, string> = {
    "raw-fetch":
      "calls raw fetch. Use ctx.http or an injected HttpClient; see Choosing the HTTP path.",
    "credentialed-fetch-json":
      "reads a credential and calls fetchJson. Use ctx.http or an injected HttpClient for credentialed requests.",
    "null-island":
      "defaults a coordinate to zero. Reject or omit the record instead of placing it at 0° N 0° E.",
  };
  for (const [key, findings] of counts) {
    const [rule, path] = key.split("\0") as [ProviderHttpRule, string];
    const exception = exceptions[rule][path];
    if (exception?.count === findings.length) continue;
    const where = findings.map((f) => `  ${path}:${f.line}  ${f.text}`).join("\n");
    failures.push(
      exception
        ? `${path} holds ${findings.length} ${rule} findings; its exception allows ${exception.count}. Update the exception only if every finding still matches its reason.\n${where}`
        : `${path} ${advice[rule]}\n${where}`,
    );
  }
  for (const rule of Object.keys(exceptions) as ProviderHttpRule[]) {
    for (const path of Object.keys(exceptions[rule])) {
      if (!modules.has(path)) {
        failures.push(`${path} is listed as a ${rule} exception but is not scanned.`);
      } else if (!counts.has(`${rule}\0${path}`)) {
        failures.push(`${path} has no ${rule} findings any more; remove its exception.`);
      }
    }
  }
  return failures;
}

function main(): void {
  const paths = [
    ...integrationServerModules(),
    ...PACKAGE_ROOTS.flatMap((root) => listModules(join(ROOT, root))),
  ];
  const modules = new Map<string, string>();
  for (const path of paths) {
    modules.set(relative(ROOT, path).split(sep).join("/"), readFileSync(path, "utf8"));
  }
  const failures = checkProviderHttp(modules);
  if (failures.length > 0) {
    console.error("Provider HTTP check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  const listed = Object.values(EXCEPTIONS).reduce(
    (total, entries) => total + Object.keys(entries).length,
    0,
  );
  console.log(`Provider HTTP check passed: ${modules.size} modules, ${listed} listed exceptions.`);
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
