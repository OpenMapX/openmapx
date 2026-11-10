import ts from "typescript";

/**
 * A static check for HTML assembled in template strings. MapLibre's
 * Popup.setHTML assigns its argument to innerHTML, so every value interpolated
 * into popup markup has to be escaped, numeric, or drawn from a fixed table.
 *
 * The check walks each template literal that contains markup and classifies the
 * expression in every `${...}` slot. A slot is safe when it is a literal, an
 * escaping or trusted-builder call, a number formatter, a lookup in a constant
 * table, or a name whose every assignment in the file is itself safe. Function
 * parameters are unsafe unless they are typed as numbers or booleans, so a
 * helper that interpolates its parameters must escape them itself.
 */

/** Functions whose return value is markup-safe regardless of their arguments. */
const TRUSTED_CALLS = new Set([
  "escapeHtml",
  "sanitizeUrl",
  "relativeTime",
  "formatTime",
  "buildPopupCard",
  "buildStackedPopupCard",
  "buildStackedPopupCardItems",
  "buildPopupCreditsHtml",
  "buildRoadConditionPopupHtml",
  "t",
  "translate",
  "Number",
  "Boolean",
  "parseInt",
  "parseFloat",
  "Math.abs",
  "Math.ceil",
  "Math.floor",
  "Math.max",
  "Math.min",
  "Math.round",
  "Math.trunc",
  "Number.isFinite",
  "Number.isNaN",
  "Number.parseFloat",
  "Number.parseInt",
]);

/** Methods that only exist on numbers, so their result is digits and punctuation. */
const NUMBER_ONLY_METHODS = new Set(["toFixed", "toPrecision", "toExponential"]);

/** Locale formatters. They echo a string receiver, so the receiver must be safe or a fresh Date or Intl formatter. */
const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);

/** Methods that return a string or array built only from the receiver's own characters. */
const PASS_THROUGH_METHODS = new Set([
  "at",
  "charAt",
  "concat",
  "filter",
  "flat",
  "join",
  "padEnd",
  "padStart",
  "repeat",
  "reverse",
  "slice",
  "sort",
  "substring",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
]);

const HTML_SINK_PATTERN =
  /\.setHTML\s*\(|\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\(|dangerouslySetInnerHTML|\.createContextualFragment\s*\(/;

const MARKUP_PATTERN = /<[A-Za-z/!]/;

type Binding =
  | { kind: "expression"; expression: ts.Expression }
  | { kind: "function"; fn: ts.FunctionLikeDeclaration }
  | { kind: "imported"; specifier: string; name: string }
  | { kind: "parameter"; typed: boolean; declaration: ts.ParameterDeclaration }
  | { kind: "constant" }
  | { kind: "opaque" };

type Scope = ts.FunctionLikeDeclaration | ts.SourceFile;

/** Where relative imports are read from, so a constant table in a sibling module still counts as constant. */
export interface ModuleHost {
  read(fromFile: string, specifier: string): { fileName: string; source: string } | undefined;
}

export interface GuardOptions {
  host?: ModuleHost;
  /** Functions whose result is escaped by a contract the analysis cannot see, such as a pre-escaped model. */
  trustedFunctions?: readonly string[];
  /** Exact expression texts that are escaped by such a contract. */
  trustedExpressions?: readonly string[];
}

export interface UnsafeInterpolation {
  line: number;
  text: string;
}

export function hasHtmlSink(source: string): boolean {
  return HTML_SINK_PATTERN.test(source);
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function hasMarkup(template: ts.TemplateExpression): boolean {
  return (
    MARKUP_PATTERN.test(template.head.text) ||
    template.templateSpans.some((span) => MARKUP_PATTERN.test(span.literal.text))
  );
}

function isMarkupTemplate(node: ts.Node): node is ts.TemplateExpression {
  return ts.isTemplateExpression(node) && hasMarkup(node);
}

function callName(callee: ts.Expression): string | null {
  const expression = unwrap(callee);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return `${expression.expression.text}.${expression.name.text}`;
  }
  return null;
}

class FileAnalysis {
  private readonly scopes = new Map<Scope, Map<string, Binding[]>>();
  private readonly visiting = new Set<ts.Node>();
  private readonly modules = new Map<string, FileAnalysis | null>();
  private identifierIndex: Map<string, ts.Identifier[]> | undefined;

  constructor(
    readonly sourceFile: ts.SourceFile,
    private readonly options: GuardOptions = {},
  ) {
    this.collectDeclarations(sourceFile);
    this.collectLoopVariables(sourceFile);
    this.collectAssignments(sourceFile);
  }

  private scopeOf(node: ts.Node): Scope {
    for (let current = node.parent; current; current = current.parent) {
      if (isFunctionLike(current) || ts.isSourceFile(current)) return current;
    }
    return this.sourceFile;
  }

  private bindingsOf(name: string, from: ts.Node): Binding[] | undefined {
    for (let scope: Scope | undefined = this.scopeOf(from); scope; ) {
      const found = this.scopes.get(scope)?.get(name);
      if (found) return found;
      scope = ts.isSourceFile(scope) ? undefined : this.scopeOf(scope);
    }
    return undefined;
  }

  private addBinding(scope: Scope, name: string, binding: Binding): void {
    let names = this.scopes.get(scope);
    if (!names) {
      names = new Map();
      this.scopes.set(scope, names);
    }
    const existing = names.get(name);
    if (existing) existing.push(binding);
    else names.set(name, [binding]);
  }

  private bindPattern(scope: Scope, name: ts.BindingName, binding: Binding): void {
    if (ts.isIdentifier(name)) {
      this.addBinding(scope, name.text, binding);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) this.bindPattern(scope, element.name, binding);
    }
  }

  private collectDeclarations(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      const scope = this.scopeOf(node);
      const initializer = node.initializer ? unwrap(node.initializer) : undefined;
      const inLoopHead =
        ts.isVariableDeclarationList(node.parent) &&
        (ts.isForOfStatement(node.parent.parent) || ts.isForInStatement(node.parent.parent));
      if (inLoopHead) {
        // Resolved by collectLoopVariables.
      } else if (ts.isIdentifier(node.name) && initializer) {
        this.addBinding(
          scope,
          node.name.text,
          isFunctionLike(initializer)
            ? { kind: "function", fn: initializer }
            : { kind: "expression", expression: initializer },
        );
      } else {
        // A declaration without a value starts empty; later assignments add to it.
        this.bindPattern(
          scope,
          node.name,
          ts.isIdentifier(node.name) ? { kind: "constant" } : { kind: "opaque" },
        );
      }
    } else if (ts.isParameter(node)) {
      const type = node.type;
      const typed =
        !!type &&
        (type.kind === ts.SyntaxKind.NumberKeyword || type.kind === ts.SyntaxKind.BooleanKeyword);
      const scope = isFunctionLike(node.parent) ? node.parent : this.scopeOf(node);
      this.bindPattern(
        scope,
        node.name,
        ts.isIdentifier(node.name)
          ? { kind: "parameter", typed, declaration: node }
          : { kind: "opaque" },
      );
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      this.addBinding(this.scopeOf(node), node.name.text, { kind: "function", fn: node });
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      this.collectImports(node, node.moduleSpecifier.text);
    }
    ts.forEachChild(node, (child) => this.collectDeclarations(child));
  }

  private collectImports(node: ts.ImportDeclaration, specifier: string): void {
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name) {
      this.addBinding(this.sourceFile, clause.name.text, { kind: "opaque" });
    }
    const named = clause.namedBindings;
    if (!named) return;
    if (ts.isNamespaceImport(named)) {
      this.addBinding(this.sourceFile, named.name.text, { kind: "opaque" });
      return;
    }
    for (const element of named.elements) {
      this.addBinding(this.sourceFile, element.name.text, {
        kind: "imported",
        specifier,
        name: (element.propertyName ?? element.name).text,
      });
    }
  }

  private importedModule(specifier: string): FileAnalysis | null {
    const cached = this.modules.get(specifier);
    if (cached !== undefined) return cached;
    const loaded = specifier.startsWith(".")
      ? this.options.host?.read(this.sourceFile.fileName, specifier)
      : undefined;
    const analysis = loaded
      ? new FileAnalysis(parseSource(loaded.source, loaded.fileName), this.options)
      : null;
    this.modules.set(specifier, analysis);
    return analysis;
  }

  /** A top-level constant table this module declares, such as a lookup of colors. */
  private declaresConstantTable(name: string): boolean {
    const bindings = this.scopes.get(this.sourceFile)?.get(name);
    if (bindings?.length !== 1) return false;
    const [binding] = bindings;
    return binding.kind === "expression" && this.isConstantData(binding.expression, new Set());
  }

  private isConstantImport(binding: Binding): boolean {
    if (binding.kind !== "imported") return false;
    return this.importedModule(binding.specifier)?.declaresConstantTable(binding.name) ?? false;
  }

  /** A loop over a constant table yields constants; any other loop yields opaque values. */
  private collectLoopVariables(node: ts.Node): void {
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      const constant =
        ts.isForOfStatement(node) && this.isConstantData(unwrap(node.expression), new Set());
      for (const declaration of node.initializer.declarations) {
        this.bindPattern(
          this.scopeOf(declaration),
          declaration.name,
          constant ? { kind: "constant" } : { kind: "opaque" },
        );
      }
    }
    ts.forEachChild(node, (child) => this.collectLoopVariables(child));
  }

  private collectAssignments(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) this.addAssignment(left, unwrap(node.right));
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        (callee.name.text === "push" || callee.name.text === "unshift")
      ) {
        for (const argument of node.arguments) {
          this.addAssignment(callee.expression, unwrap(argument));
        }
      }
    }
    ts.forEachChild(node, (child) => this.collectAssignments(child));
  }

  /** Records a later value for a name against the declaration it resolves to. */
  private addAssignment(target: ts.Identifier, value: ts.Expression): void {
    const bindings = this.bindingsOf(target.text, target);
    if (bindings) bindings.push({ kind: "expression", expression: value });
    else this.addBinding(this.sourceFile, target.text, { kind: "opaque" });
  }

  isConstantData(expression: ts.Expression, seen: Set<ts.Node>): boolean {
    const current = unwrap(expression);
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isNumericLiteral(current) ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      current.kind === ts.SyntaxKind.NullKeyword
    ) {
      return true;
    }
    if (ts.isPrefixUnaryExpression(current)) return this.isConstantData(current.operand, seen);
    if (ts.isArrayLiteralExpression(current)) {
      return current.elements.every((element) => this.isConstantData(element, seen));
    }
    if (ts.isObjectLiteralExpression(current)) {
      return current.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) && this.isConstantData(property.initializer, seen),
      );
    }
    if (ts.isIdentifier(current)) {
      const bindings = this.bindingsOf(current.text, current);
      if (bindings?.length !== 1) return false;
      const [binding] = bindings;
      if (binding.kind === "imported") return this.isConstantImport(binding);
      if (binding.kind !== "expression" || seen.has(binding.expression)) return false;
      seen.add(binding.expression);
      return this.isConstantData(binding.expression, seen);
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      return this.isConstantData(current.expression, seen);
    }
    return false;
  }

  /** The first sub-expression that is not provably safe to emit as markup, or null. */
  unsafeNode(expression: ts.Expression): ts.Node | null {
    const current = unwrap(expression);
    if (this.options.trustedExpressions?.includes(current.getText())) return null;

    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isNumericLiteral(current) ||
      ts.isBigIntLiteral(current) ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      current.kind === ts.SyntaxKind.NullKeyword
    ) {
      return null;
    }

    if (ts.isTemplateExpression(current)) {
      for (const span of current.templateSpans) {
        const unsafe = this.unsafeNode(span.expression);
        if (unsafe) return unsafe;
      }
      return null;
    }

    if (ts.isConditionalExpression(current)) {
      return this.unsafeNode(current.whenTrue) ?? this.unsafeNode(current.whenFalse);
    }

    if (ts.isBinaryExpression(current)) {
      switch (current.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.AmpersandAmpersandToken:
        case ts.SyntaxKind.QuestionQuestionToken:
          return this.unsafeNode(current.left) ?? this.unsafeNode(current.right);
        case ts.SyntaxKind.CommaToken:
          return this.unsafeNode(current.right);
        case ts.SyntaxKind.MinusToken:
        case ts.SyntaxKind.AsteriskToken:
        case ts.SyntaxKind.SlashToken:
        case ts.SyntaxKind.PercentToken:
        case ts.SyntaxKind.AsteriskAsteriskToken:
        case ts.SyntaxKind.EqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        case ts.SyntaxKind.LessThanToken:
        case ts.SyntaxKind.LessThanEqualsToken:
        case ts.SyntaxKind.GreaterThanToken:
        case ts.SyntaxKind.GreaterThanEqualsToken:
        case ts.SyntaxKind.InKeyword:
        case ts.SyntaxKind.InstanceOfKeyword:
          return null;
        default:
          return current;
      }
    }

    if (ts.isPrefixUnaryExpression(current) || ts.isTypeOfExpression(current)) return null;

    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        const unsafe = this.unsafeNode(ts.isSpreadElement(element) ? element.expression : element);
        if (unsafe) return unsafe;
      }
      return null;
    }

    if (ts.isNewExpression(current)) {
      const target = unwrap(current.expression);
      return ts.isIdentifier(target) && target.text === "Date" ? null : current;
    }

    if (ts.isIdentifier(current)) return this.unsafeIdentifier(current);

    if (ts.isPropertyAccessExpression(current) && current.name.text === "length") return null;

    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      if (this.isConstantData(current.expression, new Set())) return null;
      return this.isTrustedResult(current.expression) ? null : current;
    }

    if (ts.isCallExpression(current)) return this.unsafeCall(current);

    return current;
  }

  /** A name that holds the result of a trusted builder, such as the popup content a builder returns. */
  private isTrustedResult(expression: ts.Expression): boolean {
    const base = unwrap(expression);
    if (ts.isCallExpression(base)) return this.unsafeNode(base) === null;
    if (!ts.isIdentifier(base)) return false;
    const bindings = this.bindingsOf(base.text, base);
    return (
      !!bindings &&
      bindings.length > 0 &&
      bindings.every(
        (binding) =>
          binding.kind === "expression" &&
          ts.isCallExpression(unwrap(binding.expression)) &&
          this.unsafeNode(binding.expression) === null,
      )
    );
  }

  private unsafeIdentifier(identifier: ts.Identifier): ts.Node | null {
    if (identifier.text === "undefined") return null;
    const bindings = this.bindingsOf(identifier.text, identifier);
    if (!bindings || bindings.length === 0) return identifier;
    for (const binding of bindings) {
      if (binding.kind === "constant") continue;
      if (binding.kind === "imported") {
        if (this.isConstantImport(binding)) continue;
        return identifier;
      }
      if (binding.kind === "parameter") {
        if (binding.typed || !this.unsafeParameter(binding.declaration)) continue;
        return identifier;
      }
      if (binding.kind === "opaque" || binding.kind === "function") return identifier;
      if (this.visiting.has(binding.expression)) continue;
      this.visiting.add(binding.expression);
      const unsafe = this.unsafeNode(binding.expression);
      this.visiting.delete(binding.expression);
      if (unsafe) return identifier;
    }
    return null;
  }

  /**
   * A parameter of a private helper is as safe as the argument at every call
   * site. Exported helpers and helpers used as values have callers this file
   * cannot see, so their parameters are unsafe.
   */
  private unsafeParameter(declaration: ts.ParameterDeclaration): boolean {
    if (this.visiting.has(declaration)) return false;
    const fn = declaration.parent;
    if (!isFunctionLike(fn)) return true;
    const name = this.helperName(fn);
    if (!name) return true;
    const index = fn.parameters.indexOf(declaration);
    this.visiting.add(declaration);
    try {
      let callSites = 0;
      for (const reference of this.references(name.text)) {
        if (reference === name) continue;
        const bindings = this.bindingsOf(name.text, reference);
        if (!bindings?.some((binding) => binding.kind === "function" && binding.fn === fn))
          continue;
        const parent = reference.parent;
        if (!ts.isCallExpression(parent) || parent.expression !== reference) return true;
        callSites += 1;
        const argument = parent.arguments[index];
        if (!argument) continue;
        if (ts.isSpreadElement(argument) || this.unsafeNode(argument)) return true;
      }
      return callSites === 0;
    } finally {
      this.visiting.delete(declaration);
    }
  }

  /** The name of a helper that is declared in this file and not exported. */
  private helperName(fn: ts.FunctionLikeDeclaration): ts.Identifier | null {
    const hasExport = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) &&
      !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(fn)) {
      return fn.name && !hasExport(fn) ? fn.name : null;
    }
    const declaration = fn.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
    const statement = declaration.parent.parent;
    return ts.isVariableStatement(statement) && hasExport(statement) ? null : declaration.name;
  }

  private references(name: string): ts.Identifier[] {
    if (!this.identifierIndex) {
      const index = new Map<string, ts.Identifier[]>();
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const existing = index.get(node.text);
          if (existing) existing.push(node);
          else index.set(node.text, [node]);
        }
        ts.forEachChild(node, visit);
      };
      visit(this.sourceFile);
      this.identifierIndex = index;
    }
    return this.identifierIndex.get(name) ?? [];
  }

  private unsafeCall(call: ts.CallExpression): ts.Node | null {
    const callee = unwrap(call.expression);

    if (ts.isIdentifier(callee)) {
      if (this.options.trustedFunctions?.includes(callee.text)) return null;
      const local = this.bindingsOf(callee.text, callee);
      if (local?.some((binding) => binding.kind === "function")) {
        return this.unsafeLocalCall(local, call);
      }
      return TRUSTED_CALLS.has(callee.text) ? null : call;
    }

    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const name = callName(callee);
      if (name && TRUSTED_CALLS.has(name)) return null;
      if (!ts.isPropertyAccessExpression(callee)) return call;
      const method = callee.name.text;
      const receiver = unwrap(callee.expression);
      if (NUMBER_ONLY_METHODS.has(method)) return null;
      if (LOCALE_METHODS.has(method)) {
        return this.unsafeNode(receiver) ? call : null;
      }
      if (method === "format") {
        return ts.isNewExpression(receiver) &&
          ts.isPropertyAccessExpression(receiver.expression) &&
          ts.isIdentifier(receiver.expression.expression) &&
          receiver.expression.expression.text === "Intl"
          ? null
          : call;
      }
      if (method === "map") return this.unsafeMap(call);
      if (PASS_THROUGH_METHODS.has(method)) {
        const unsafeReceiver = this.unsafeNode(receiver);
        if (unsafeReceiver) return unsafeReceiver;
        for (const argument of call.arguments) {
          if (ts.isIdentifier(argument) && argument.text === "Boolean") continue;
          if (isFunctionLike(unwrap(argument))) continue;
          const unsafe = this.unsafeNode(argument);
          if (unsafe) return unsafe;
        }
        return null;
      }
    }

    return call;
  }

  private unsafeMap(call: ts.CallExpression): ts.Node | null {
    const [callback] = call.arguments;
    if (!callback) return call;
    const target = unwrap(callback);
    if (isFunctionLike(target)) return this.unsafeReturns(target);
    if (ts.isIdentifier(target)) {
      const local = this.bindingsOf(target.text, target);
      if (local?.some((binding) => binding.kind === "function")) {
        return this.unsafeLocalCall(local, call);
      }
      return TRUSTED_CALLS.has(target.text) ? null : call;
    }
    return call;
  }

  /** A call to a function declared in this file is as safe as everything it returns. */
  private unsafeLocalCall(bindings: readonly Binding[], call: ts.CallExpression): ts.Node | null {
    for (const binding of bindings) {
      if (binding.kind !== "function") return call;
      if (this.unsafeReturns(binding.fn)) return call;
    }
    return null;
  }

  private unsafeReturns(fn: ts.FunctionLikeDeclaration): ts.Node | null {
    if (this.visiting.has(fn)) return null;
    this.visiting.add(fn);
    try {
      const body = fn.body;
      if (!body) return fn;
      if (!ts.isBlock(body)) return this.unsafeNode(body);
      let unsafe: ts.Node | null = null;
      const visit = (node: ts.Node): void => {
        if (unsafe || (node !== body && isFunctionLike(node))) return;
        if (ts.isReturnStatement(node) && node.expression) {
          unsafe = this.unsafeNode(node.expression);
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
      return unsafe;
    } finally {
      this.visiting.delete(fn);
    }
  }
}

function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function insideNestedMarkup(node: ts.Node, boundary: ts.Node): boolean {
  if (node === boundary) return false;
  for (let current: ts.Node | undefined = node.parent; current && current !== boundary; ) {
    if (isMarkupTemplate(current)) return true;
    current = current.parent;
  }
  return false;
}

const HTML_ASSIGNMENT_PROPERTIES = new Set(["innerHTML", "outerHTML"]);
const HTML_CALL_METHODS: Record<string, number> = {
  setHTML: 0,
  insertAdjacentHTML: 1,
  createContextualFragment: 0,
};

/** The expression a statement hands to an HTML sink, if the node is one. */
function sinkArgument(node: ts.Node): ts.Expression | null {
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const index = HTML_CALL_METHODS[callee.name.text];
      if (index !== undefined) return node.arguments[index] ?? null;
    }
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = unwrap(node.left);
    if (ts.isPropertyAccessExpression(left) && HTML_ASSIGNMENT_PROPERTIES.has(left.name.text)) {
      return node.right;
    }
  } else if (
    ts.isJsxAttribute(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "dangerouslySetInnerHTML" &&
    node.initializer &&
    ts.isJsxExpression(node.initializer) &&
    node.initializer.expression
  ) {
    const value = unwrap(node.initializer.expression);
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "__html"
        ) {
          return property.initializer;
        }
      }
    }
  }
  return null;
}

function isTextLiteral(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** The operands of a chain of `+`, left to right. */
function concatenationOperands(node: ts.BinaryExpression): ts.Expression[] {
  const operands: ts.Expression[] = [];
  const flatten = (expression: ts.Expression): void => {
    const current = unwrap(expression);
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      flatten(current.left);
      flatten(current.right);
    } else {
      operands.push(current);
    }
  };
  flatten(node);
  return operands;
}

function isConcatenation(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/**
 * Values that reach markup without being provably escaped, numeric or fixed:
 * interpolations into markup-bearing template strings, operands joined to markup
 * with `+`, and any other value handed straight to an HTML sink.
 */
export function findUnsafeInterpolations(
  source: string,
  fileName: string,
  options: GuardOptions = {},
): UnsafeInterpolation[] {
  const sourceFile = parseSource(source, fileName);
  const analysis = new FileAnalysis(sourceFile, options);
  const offenders: UnsafeInterpolation[] = [];
  const seen = new Set<ts.Node>();

  const report = (node: ts.Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    offenders.push({ line: position.line + 1, text: node.getText() });
  };

  const visit = (node: ts.Node): void => {
    if (isMarkupTemplate(node)) {
      for (const span of node.templateSpans) {
        const unsafe = analysis.unsafeNode(span.expression);
        if (unsafe && !insideNestedMarkup(unsafe, span.expression)) report(unsafe);
      }
    } else if (isConcatenation(node) && !isConcatenation(node.parent)) {
      const operands = concatenationOperands(node);
      const hasMarkupText = operands.some(
        (operand) =>
          (isTextLiteral(operand) && MARKUP_PATTERN.test(operand.text)) ||
          (ts.isTemplateExpression(operand) && hasMarkup(operand)),
      );
      if (hasMarkupText) {
        for (const operand of operands) {
          if (isTextLiteral(operand) || isMarkupTemplate(operand)) continue;
          const unsafe = analysis.unsafeNode(operand);
          if (unsafe && !insideNestedMarkup(unsafe, operand)) report(unsafe);
        }
      }
    }

    const argument = sinkArgument(node);
    if (argument && !isMarkupTemplate(unwrap(argument))) {
      const unsafe = analysis.unsafeNode(argument);
      if (unsafe) report(unsafe);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}
