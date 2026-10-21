import ts from "typescript";

// Shared by the runtime import graph check and the runtime bundler. Plain
// JavaScript, so the release plan job can load it without a TypeScript loader.

function typeOnlyImport(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function isImportMeta(node, property) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === property
  );
}

/**
 * The runtime facts of one module that a bundle can change:
 * - `specifiers`: module specifiers it loads at runtime (type-only imports and
 *   exports are erased, so they are not listed);
 * - `computedImport`: an `import()` or `require()` whose specifier is not a
 *   literal;
 * - `assetUrls`: literal `new URL("…", import.meta.url)` references, with the
 *   source range of the literal so a bundler can rewrite it;
 * - `localRequires`: literal calls of a `require` created with
 *   `createRequire(import.meta.url)`, with the source range of the literal;
 * - `locationSensitive`: any other use of `import.meta` (`url`, `dirname`,
 *   `resolve`, `main`, …) or of `__dirname`/`__filename`, which means
 *   something different once the module is bundled.
 */
export function analyzeModule(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const assetUrls = [];
  const locationSensitive = [];
  let computedImport = false;
  const assetMetaNodes = new Set();
  // `const require = createRequire(import.meta.url)`: the binding may only be
  // called with literal specifiers, which a bundler can pin.
  const localRequireBindings = new Set();
  const bindingDeclarations = new Set();
  const identifierUses = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length === 1 &&
      isImportMeta(node.initializer.arguments[0], "url") &&
      ((ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "createRequire") ||
        (ts.isPropertyAccessExpression(node.initializer.expression) &&
          node.initializer.expression.name.text === "createRequire"))
    ) {
      localRequireBindings.add(node.name.text);
      bindingDeclarations.add(node.name);
      assetMetaNodes.add(node.initializer.arguments[0]);
    }
    if (ts.isIdentifier(node)) identifierUses.push(node);
    if (ts.isImportDeclaration(node)) {
      if (!typeOnlyImport(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) {
        const [argument] = node.arguments;
        if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
        else computedImport = true;
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      isImportMeta(node.arguments[1], "url") &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const literal = node.arguments[0];
      assetUrls.push({
        specifier: literal.text,
        start: literal.getStart(source),
        end: literal.getEnd(),
      });
      assetMetaNodes.add(node.arguments[1]);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      isImportMeta(node, node.name.text) &&
      !assetMetaNodes.has(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      locationSensitive.push(`import.meta.${node.name.text} (line ${line + 1})`);
    } else if (
      ts.isIdentifier(node) &&
      (node.text === "__dirname" || node.text === "__filename") &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      locationSensitive.push(`${node.text} (line ${line + 1})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const localRequires = [];
  for (const identifier of identifierUses) {
    if (!localRequireBindings.has(identifier.text) || bindingDeclarations.has(identifier)) continue;
    const parent = identifier.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) continue;
    const [argument] =
      ts.isCallExpression(parent) && parent.expression === identifier ? parent.arguments : [];
    if (argument && ts.isStringLiteralLike(argument) && parent.arguments.length === 1) {
      localRequires.push({
        specifier: argument.text,
        start: argument.getStart(source),
        end: argument.getEnd(),
      });
    } else {
      const { line } = source.getLineAndCharacterOfPosition(identifier.getStart(source));
      locationSensitive.push(
        `${identifier.text} from createRequire(import.meta.url) is used other than with a literal specifier (line ${line + 1})`,
      );
    }
  }
  return { specifiers, computedImport, assetUrls, localRequires, locationSensitive };
}
