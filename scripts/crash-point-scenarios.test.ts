import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The suite's import bans are Biome rules (biome.json, the crash-points
// overrides); this test keeps the known-failures registry honest.
const root = resolve(import.meta.dirname, "..");
const suite = "apps/api/src/services/__tests__/crash-points";

describe("crash-point known failures", () => {
  const scenarioFiles = readdirSync(resolve(root, suite, "scenarios"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `${suite}/scenarios/${name}`);
  /** Every scenario declared with the suite's wrapper, by file and name. */
  const declared = scenarioFiles.flatMap((file) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(resolve(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const names: { file: string; name: string | undefined }[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "crashScenario"
      ) {
        const [options] = node.arguments;
        const name =
          options && ts.isObjectLiteralExpression(options)
            ? options.properties.find(
                (property): property is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(property) &&
                  ts.isIdentifier(property.name) &&
                  property.name.text === "name",
              )?.initializer
            : undefined;
        names.push({ file, name: name && ts.isStringLiteralLike(name) ? name.text : undefined });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
  });
  const registry = JSON.parse(
    readFileSync(resolve(root, suite, "known-failures.json"), "utf8"),
  ) as Record<string, unknown>;

  it("declares one scenario per file through the wrapper, each with a literal name", () => {
    expect(scenarioFiles.length).toBeGreaterThan(0);
    for (const file of scenarioFiles) {
      const own = declared.filter((entry) => entry.file === file);
      expect(own, file).toHaveLength(1);
      expect(own[0]?.name, `${file}: name`).toEqual(expect.any(String));
      expect(readFileSync(resolve(root, file), "utf8"), file).not.toMatch(
        /(?<![\w.])(?:it|test|describe)(?:\.\w+)*\(/,
      );
    }
    const names = declared.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names only existing scenarios, each with a reason and a failure signature", () => {
    const names = new Set(declared.map((entry) => entry.name));
    for (const [name, entry] of Object.entries(registry)) {
      expect(names.has(name), `known failure "${name}" names no scenario`).toBe(true);
      expect(entry, name).toEqual({ reason: expect.any(String), fails: expect.any(String) });
      const { reason, fails } = entry as { reason: string; fails: string };
      expect(reason.trim().length, `${name}: reason`).toBeGreaterThan(0);
      expect(fails.trim().length, `${name}: failure signature`).toBeGreaterThan(0);
      expect(() => new RegExp(fails), `${name}: failure signature`).not.toThrow();
    }
  });
});
