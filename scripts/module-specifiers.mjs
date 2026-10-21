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
 * - `computedImport`: an `import()` whose specifier is not a literal;
 * - `assetUrls`: literal `new URL("…", import.meta.url)` references, with the
 *   source range of the literal so a bundler can rewrite it;
 * - `locationSensitive`: any other use of the module's own location
 *   (`import.meta.url`, `import.meta.dirname`, `__dirname`, …), which means
 *   something different once the module is bundled.
 */
export function analyzeModule(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const assetUrls = [];
  const locationSensitive = [];
  let computedImport = false;
  const assetMetaNodes = new Set();
  const visit = (node) => {
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
        else if (isImport) computedImport = true;
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
      ["url", "dirname", "filename"].some((property) => isImportMeta(node, property)) &&
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
  return { specifiers, computedImport, assetUrls, locationSensitive };
}
