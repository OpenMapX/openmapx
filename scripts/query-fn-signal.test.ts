import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every TanStack `queryFn` in browser code takes the query's abort signal, so
 * a request whose last observer unmounts, or whose key changes, is cancelled
 * instead of finishing for nobody. A query function passes the signal on by
 * destructuring `{ signal }`, or forwards the whole query context it names.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SCANNED = [
  "apps/web/src",
  "packages/core/src",
  "packages/mangrove-react/src",
  "integrations",
];

/** Query functions that deliberately run without the signal, with the reason. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "apps/web/src/components/panels/parking/useSaveParking.ts": {
    count: 1,
    reason:
      "an observerless fetchQuery that fills a saved spot's address after the panel closes. It shares the map's reverse-geocode cache entry, so it can join the map's signal-taking lookup, which the closing panel cancels; it then asks again with its own query function, which nothing cancels",
  },
};

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "generated")
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.test\.tsx?$/.test(entry.name)
    )
      out.push(full);
  }
  return out;
}

/** The references to `name` inside `node`. */
function referencesTo(node: ts.Node, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && child.text === name) {
      const parent = child.parent;
      // `x.name` and `{ name: x }` name a property, not the binding.
      const namesProperty =
        (ts.isPropertyAccessExpression(parent) && parent.name === child) ||
        (ts.isPropertyAssignment(parent) && parent.name === child);
      if (!namesProperty) found.push(child);
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/**
 * Whether a use of the query context hands its signal on: reading
 * `context.signal`, or passing the context on whole. Reading another field,
 * such as `context.queryKey`, does not.
 */
function forwardsSignal(reference: ts.Identifier): boolean {
  const parent = reference.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
    return parent.name.text === "signal";
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === reference) return false;
  return true;
}

/** Whether a binding, possibly destructured, introduces `name`. */
function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(element.name, name),
  );
}

/**
 * What `name` refers to in the nearest scope around `from` that declares it:
 * the initializer of a `const`/`let`, or a function declaration's body. A
 * parameter, an import or a destructured binding resolves to nothing.
 */
function resolveLocal(from: ts.Node, name: string): ts.Expression | undefined {
  for (let scope = from.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => bindsName(p.name, name))) {
      return undefined;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) continue;
    for (const statement of scope.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!bindsName(declaration.name, name)) continue;
          return ts.isIdentifier(declaration.name) ? declaration.initializer : undefined;
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
        return statement.body
          ? ts.factory.createFunctionExpression(
              undefined,
              undefined,
              undefined,
              undefined,
              statement.parameters,
              undefined,
              statement.body,
            )
          : undefined;
      }
    }
  }
  return undefined;
}

/** Whether a query function takes the signal, or forwards the context that carries it. */
function takesSignal(fn: ts.Expression): boolean {
  if (ts.isIdentifier(fn)) {
    const target = resolveLocal(fn, fn.text);
    return target !== undefined && !ts.isIdentifier(target) && takesSignal(target);
  }
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const [first] = fn.parameters;
  if (!first) return false;
  if (ts.isObjectBindingPattern(first.name)) {
    return first.name.elements.some((element) => {
      if (!ts.isIdentifier(element.name)) return false;
      const binding = element.name.text;
      if (element.dotDotDotToken !== undefined) {
        return referencesTo(fn.body, binding).some(forwardsSignal);
      }
      return (
        (element.propertyName ?? element.name).getText() === "signal" &&
        referencesTo(fn.body, binding).length > 0
      );
    });
  }
  return ts.isIdentifier(first.name) && referencesTo(fn.body, first.name.text).some(forwardsSignal);
}

/** The `file:line` of every query function in `source` that drops the signal. */
function offendersIn(file: string, source = readFileSync(file, "utf8")): string[] {
  if (!source.includes("queryFn")) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const fn =
      ts.isPropertyAssignment(node) && node.name.getText(sf) === "queryFn"
        ? node.initializer
        : ts.isShorthandPropertyAssignment(node) && node.name.text === "queryFn"
          ? node.name
          : undefined;
    if (fn && !takesSignal(fn)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push(`${relative(ROOT, file)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("the query-function check", () => {
  const check = (body: string) => offendersIn(join(ROOT, "fixture.ts"), body).length === 0;

  it.each([
    [
      "a destructured signal passed on",
      "useQuery({ queryFn: ({ signal }) => get(url, { signal }) });",
    ],
    [
      "a renamed signal passed on",
      "useQuery({ queryFn: ({ signal: s }) => get(url, { signal: s }) });",
    ],
    ["the context's signal", "useQuery({ queryFn: (ctx) => get(url, { signal: ctx.signal }) });"],
    ["the whole context", "useQuery({ queryFn: (ctx) => load(ctx) });"],
    [
      "the rest of the context",
      "useQuery({ queryFn: ({ queryKey, ...rest }) => load(queryKey, rest) });",
    ],
    [
      "a shorthand local function",
      "const queryFn = ({ signal }) => get(url, { signal }); useQuery({ queryFn });",
    ],
    [
      "a shorthand function declaration",
      "function queryFn({ signal }) { return get(url, { signal }); } useQuery({ queryFn });",
    ],
    [
      "a shorthand whose own scope passes the signal while another scope drops it",
      "function a() { const queryFn = () => get(url); return queryFn; }" +
        " function b() { const queryFn = ({ signal }) => get(url, { signal }); return useQuery({ queryFn }); }",
    ],
  ])("accepts %s", (_, body) => {
    expect(check(body)).toBe(true);
  });

  it.each([
    ["no parameter", "useQuery({ queryFn: () => get(url) });"],
    ["a destructured signal never used", "useQuery({ queryFn: ({ signal }) => get(url) });"],
    [
      "a context read only for its key",
      "useQuery({ queryFn: (ctx) => get(url, { id: ctx.queryKey[1] }) });",
    ],
    ["a rest read only for its key", "useQuery({ queryFn: ({ ...ctx }) => get(ctx.queryKey) });"],
    [
      "a shorthand function without the signal",
      "const queryFn = () => get(url); useQuery({ queryFn });",
    ],
    [
      "a shorthand name declared elsewhere",
      "import { queryFn } from './x'; useQuery({ queryFn });",
    ],
    [
      "a shorthand whose own scope drops the signal while another scope passes it",
      "function a() { const queryFn = ({ signal }) => get(url, { signal }); return useQuery({ queryFn }); }" +
        " function b() { const queryFn = () => get(url); return useQuery({ queryFn }); }",
    ],
    [
      "a shorthand naming a parameter that shadows a passing function",
      "const queryFn = ({ signal }) => get(url, { signal });" +
        " function useLookup(queryFn) { return useQuery({ queryFn }); }",
    ],
  ])("rejects %s", (_, body) => {
    expect(check(body)).toBe(false);
  });
});

describe("query functions take the abort signal", () => {
  const files = SCANNED.flatMap((dir) => collectFiles(resolve(ROOT, dir)));
  const offenders = files.flatMap((file) => offendersIn(file));
  const byFile = new Map<string, number>();
  for (const hit of offenders) {
    const file = hit.slice(0, hit.lastIndexOf(":"));
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }

  it("scans the browser sources", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("finds no query function that drops the signal outside the allowlist", () => {
    const unexpected = offenders.filter((hit) => !ALLOWED[hit.slice(0, hit.lastIndexOf(":"))]);
    expect(
      unexpected,
      `Destructure { signal } and pass it to the request:\n${unexpected.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps every allowlist entry exact", () => {
    for (const [file, { count }] of Object.entries(ALLOWED)) {
      expect(byFile.get(file) ?? 0, file).toBe(count);
    }
  });
});
