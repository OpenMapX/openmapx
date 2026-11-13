import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const suite = "apps/api/src/services/__tests__/crash-points";

/** Representation the crash-point suite must not depend on: it observes the
 * system only from outside, so it keeps passing when these internals change. */
const forbidden: { label: string; matches: (specifier: string, file: string) => boolean }[] = [
  {
    label: "the signed control layer",
    matches: (specifier) =>
      specifier === "@openmapx/core/build-artifacts" ||
      specifier.startsWith("@openmapx/core/build-artifacts/"),
  },
  ...["packages/core/src/build-artifacts", "apps/ops-agent/src", "services/data-manager/src"].map(
    (directory) => ({
      label: directory,
      matches: (specifier: string, file: string) => {
        if (!specifier.startsWith(".")) return false;
        const target = relative(root, resolve(root, dirname(file), specifier));
        return target === directory || target.startsWith(`${directory}/`);
      },
    }),
  ),
];

function files(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return files(path);
    return /\.(?:[cm]?[jt]s)$/.test(entry.name) ? [path] : [];
  });
}

/** Every module specifier a file names: static and dynamic imports, re-exports
 * and string arguments of `require` or a `createRequire(...)` call. */
function specifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        (ts.isIdentifier(callee) && callee.text === "require") || ts.isCallExpression(callee);
      const [first] = node.arguments;
      if ((isImport || isRequire) && first && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("crash-point suite imports", () => {
  it("never imports the control layer, the agent or the data-manager", () => {
    const inventory = files(suite);
    expect(inventory.some((file) => file.endsWith("/driver.ts"))).toBe(true);
    const violations = inventory.flatMap((file) =>
      specifiers(file).flatMap((specifier) =>
        forbidden
          .filter((rule) => rule.matches(specifier, file))
          .map((rule) => `${file} imports ${specifier} (${rule.label})`),
      ),
    );
    expect(violations).toEqual([]);
  });

  it("recognises the forbidden forms it is meant to refuse", () => {
    const file = `${suite}/scenarios/example.test.ts`;
    const refused = (specifier: string) => forbidden.some((rule) => rule.matches(specifier, file));
    expect(refused("@openmapx/core/build-artifacts")).toBe(true);
    expect(refused("../../../../../../ops-agent/src/server")).toBe(true);
    expect(refused("../../../../../../../services/data-manager/src/service")).toBe(true);
    expect(refused("../../../../../../../packages/core/src/build-artifacts/filesystem")).toBe(true);
    expect(refused("@openmapx/core/ops")).toBe(false);
    expect(refused("../driver")).toBe(false);
  });
});

describe("crash-point known failures", () => {
  const scenarioFiles = files(`${suite}/scenarios`).filter((file) => file.endsWith(".test.ts"));
  /** Every scenario name declared with the suite's wrapper, by file. */
  const declared = scenarioFiles.flatMap((file) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(resolve(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const names: { file: string; name: string }[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "scenario" &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        names.push({ file, name: node.arguments[0].text });
      ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
  });
  const registry = JSON.parse(
    readFileSync(resolve(root, suite, "known-failures.json"), "utf8"),
  ) as Record<string, unknown>;

  it("declares every scenario through the wrapper, once per name", () => {
    expect(scenarioFiles.length).toBeGreaterThan(0);
    for (const file of scenarioFiles) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(
        declared.filter((entry) => entry.file === file),
        file,
      ).toHaveLength(1);
      expect(source, `${file} declares tests only through scenario()`).not.toMatch(
        /(?<![\w.])(?:it|test)(?:\.\w+)*\(/,
      );
    }
    const names = declared.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names only existing scenarios, each with a reason", () => {
    const names = new Set(declared.map((entry) => entry.name));
    for (const [name, reason] of Object.entries(registry)) {
      expect(names.has(name), `known failure "${name}" names no scenario`).toBe(true);
      expect(typeof reason === "string" && reason.trim().length > 0, name).toBe(true);
    }
  });
});
