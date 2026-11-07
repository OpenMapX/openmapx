import { createHash } from "node:crypto";
import ts from "typescript";

// Reviewed fixed DOM-only viewport program from #810. Changing its source needs
// another explicit review; a familiar export name alone is not trusted code.
const REVIEWED_VIEWPORT_SOURCE_SHA256 =
  "08b0bdfe420ffcfb15179b0b7d3e4ccb435258fe4344c02da391e18b31378c50";
const BINDING = "VIEWPORT_LOCK_SCRIPT";

/** No downloaded, interpolated or substituted document-end code is allowed. */
export function hasOnlyReviewedDocumentEndScript(app: string, viewportSource: string): boolean {
  const source = ts.createSourceFile(
    "App.tsx",
    app,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const scripts: ts.JsxAttribute[] = [];
  let reviewedImports = 0;
  let bindingReferences = 0;
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === BINDING) bindingReferences++;
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "injectedJavaScript")
      scripts.push(node);
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./bridge/viewportScript" &&
      node.importClause &&
      !node.importClause.isTypeOnly &&
      node.importClause.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const item of node.importClause.namedBindings.elements)
        if (!item.isTypeOnly && !item.propertyName && item.name.text === BINDING) reviewedImports++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (scripts.length === 0) return true;
  if (scripts.length !== 1 || reviewedImports !== 1 || bindingReferences !== 2) return false;
  const initializer = scripts[0]?.initializer;
  return (
    initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === BINDING &&
    createHash("sha256").update(viewportSource).digest("hex") === REVIEWED_VIEWPORT_SOURCE_SHA256
  );
}
