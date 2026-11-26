/**
 * Provider HTTP path analysis.
 *
 * Server-side integration code chooses one of three HTTP paths (see "Choosing
 * the HTTP path" in the integration system documentation): the host
 * `HttpClient` for credentialed, quota-bound, binary or tile requests;
 * `fetchJson` for public, unkeyed JSON from a fixed host; `safeFetch*` when the
 * URL comes from data or configuration. This analysis refuses three things:
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
 * Each exception names the exact number of findings in one file and the reason
 * they are acceptable.
 *
 * The repository's gate runs this file directly under
 * `node --experimental-strip-types`, which maps no `.js` specifier to `.ts` and
 * accepts only erasable syntax. It therefore imports nothing but `node:*` and
 * `typescript`, and no sibling module.
 */
import ts from "typescript";

export type ProviderHttpRule = "raw-fetch" | "credentialed-fetch-json" | "null-island";

export interface ProviderHttpException {
  /** How many findings of this rule the file holds; any other number fails the gate. */
  readonly count: number;
  readonly reason: string;
}

export type ProviderHttpExceptions = Readonly<
  Record<ProviderHttpRule, Readonly<Record<string, ProviderHttpException>>>
>;

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

/**
 * `fetchJson` and the shared wrappers around it, under the specifiers the
 * repository's integrations and an extension author import them from.
 */
const FETCH_JSON_HELPERS: ReadonlyArray<{ module: string; name: string }> = [
  { module: "@openmapx/core", name: "fetchJson" },
  { module: "@openmapx/integration-sdk/http", name: "fetchJson" },
  { module: "@openmapx/provider-kit/weather", name: "fetchJsonWithTimeout" },
  { module: "@openmapx/integration-sdk/weather", name: "fetchJsonWithTimeout" },
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
    findings.push({ rule, line: line + 1, text: node.getText(source).replace(/\n.*$/s, "") });
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

/**
 * One failure message per file whose findings no exception covers exactly, and
 * per exception that names an unscanned file or a file without findings.
 */
export function checkProviderHttp(
  modules: ReadonlyMap<string, string>,
  exceptions: ProviderHttpExceptions,
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
