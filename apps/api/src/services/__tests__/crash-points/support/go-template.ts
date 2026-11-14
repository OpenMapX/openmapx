/** The subset of Go text/template that Docker `--format` arguments use in this
 * repository: field paths, `json`, `index`, `split`, `join`, `println`, `len`,
 * `range` and `if`/`else`. Anything else is refused so an unexpected format
 * fails loudly instead of answering something Docker never would. */

type Value = unknown;
type Node =
  | { type: "text"; text: string }
  | { type: "action"; expr: Expr }
  | { type: "range"; expr: Expr; body: Node[] }
  | { type: "if"; expr: Expr; body: Node[]; otherwise: Node[] };
type Expr =
  | { type: "field"; path: string[] }
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "call"; name: string; args: Expr[] };

const FUNCTIONS = new Set([
  "json",
  "index",
  "split",
  "join",
  "println",
  "len",
  "lower",
  "upper",
  "eq",
  "ne",
  "not",
  "and",
  "or",
]);

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s/.test(char)) {
      index++;
    } else if (char === "(" || char === ")") {
      tokens.push(char);
      index++;
    } else if (char === '"') {
      let end = index + 1;
      let value = "";
      while (end < source.length && source[end] !== '"') {
        if (source[end] === "\\") {
          const next = source[end + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
          end += 2;
        } else value += source[end++];
      }
      if (source[end] !== '"') throw new Error(`Unterminated string in ${source}`);
      tokens.push(JSON.stringify(value));
      index = end + 1;
    } else {
      let end = index;
      while (end < source.length && !/[\s()"]/.test(source[end] as string)) end++;
      tokens.push(source.slice(index, end));
      index = end;
    }
  }
  return tokens;
}

function parseExpr(tokens: string[]): Expr {
  let position = 0;
  const operand = (): Expr => {
    const token = tokens[position++];
    if (token === undefined) throw new Error("Template expression ended early");
    if (token === "(") {
      const inner = call();
      if (tokens[position++] !== ")") throw new Error("Unbalanced template parentheses");
      return inner;
    }
    if (token.startsWith('"')) return { type: "string", value: JSON.parse(token) as string };
    if (/^-?[0-9]+$/.test(token)) return { type: "number", value: Number(token) };
    if (token === ".") return { type: "field", path: [] };
    if (token.startsWith(".")) return { type: "field", path: token.slice(1).split(".") };
    if (FUNCTIONS.has(token)) return { type: "call", name: token, args: [] };
    throw new Error(`Unsupported template token ${token}`);
  };
  const call = (): Expr => {
    const first = operand();
    if (first.type !== "call") return first;
    const args: Expr[] = [];
    while (position < tokens.length && tokens[position] !== ")") args.push(operand());
    return { ...first, args };
  };
  const expr = call();
  if (position !== tokens.length) throw new Error("Unexpected trailing template tokens");
  return expr;
}

function parse(source: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ nodes: Node[]; node?: Node & { type: "range" | "if" }; inElse?: boolean }> =
    [{ nodes: root }];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{{", index);
    const current = stack.at(-1) as (typeof stack)[number];
    if (open < 0) {
      current.nodes.push({ type: "text", text: source.slice(index) });
      break;
    }
    if (open > index) current.nodes.push({ type: "text", text: source.slice(index, open) });
    const close = source.indexOf("}}", open);
    if (close < 0) throw new Error(`Unterminated template action in ${source}`);
    const action = source
      .slice(open + 2, close)
      .replace(/^-\s*/, "")
      .replace(/\s*-$/, "")
      .trim();
    index = close + 2;
    if (action === "end") {
      if (stack.length === 1) throw new Error("Unbalanced template end");
      stack.pop();
    } else if (action === "else") {
      const frame = stack.at(-1);
      if (frame?.node?.type !== "if") throw new Error("Template else outside if");
      frame.inElse = true;
      frame.nodes = frame.node.otherwise;
    } else if (action.startsWith("range ") || action.startsWith("if ")) {
      const keyword = action.startsWith("range ") ? "range" : "if";
      const expr = parseExpr(tokenize(action.slice(keyword.length + 1)));
      const node: Node & { type: "range" | "if" } =
        keyword === "range"
          ? { type: "range", expr, body: [] }
          : { type: "if", expr, body: [], otherwise: [] };
      current.nodes.push(node);
      stack.push({ nodes: node.body, node });
    } else current.nodes.push({ type: "action", expr: parseExpr(tokenize(action)) });
  }
  if (stack.length !== 1) throw new Error(`Unbalanced template in ${source}`);
  return root;
}

function evaluate(expr: Expr, dot: Value): Value {
  if (expr.type === "string" || expr.type === "number") return expr.value;
  if (expr.type === "field") {
    let value: Value = dot;
    for (const key of expr.path) {
      if (value === null || value === undefined) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }
  const args = expr.args.map((arg) => evaluate(arg, dot));
  switch (expr.name) {
    case "json":
      return JSON.stringify(args[0] ?? null);
    case "index": {
      let value = args[0];
      for (const key of args.slice(1)) {
        if (value === null || value === undefined) return undefined;
        value = (value as Record<string, unknown>)[String(key)];
      }
      return value;
    }
    case "split":
      return String(args[0] ?? "").split(String(args[1]));
    case "join":
      return (args[0] as unknown[]).join(String(args[1]));
    case "println":
      return `${args.map(print).join(" ")}\n`;
    case "len":
      return Array.isArray(args[0])
        ? args[0].length
        : Object.keys((args[0] as object | null) ?? {}).length;
    case "lower":
      return String(args[0]).toLowerCase();
    case "upper":
      return String(args[0]).toUpperCase();
    case "eq":
      return args.slice(1).some((value) => value === args[0]);
    case "ne":
      return args[0] !== args[1];
    case "not":
      return !truthy(args[0]);
    case "and":
      return args.find((value) => !truthy(value)) ?? args.at(-1);
    case "or":
      return args.find((value) => truthy(value)) ?? args.at(-1);
    default:
      throw new Error(`Unsupported template function ${expr.name}`);
  }
}

function print(value: Value): string {
  if (value === undefined || value === null) return "<no value>";
  if (Array.isArray(value)) return `[${value.map(print).join(" ")}]`;
  if (typeof value === "object") {
    return `map[${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${key}:${print(item)}`)
      .join(" ")}]`;
  }
  return String(value);
}

function truthy(value: Value): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function render(nodes: Node[], dot: Value): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += node.text;
    else if (node.type === "action") {
      const value = evaluate(node.expr, dot);
      output += typeof value === "string" ? value : print(value);
    } else if (node.type === "range") {
      const value = evaluate(node.expr, dot);
      const items = Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? Object.values(value)
          : [];
      for (const item of items) output += render(node.body, item);
    } else
      output += truthy(evaluate(node.expr, dot))
        ? render(node.body, dot)
        : render(node.otherwise, dot);
  }
  return output;
}

/** Renders a Docker `--format` template against one object. */
export function renderGoTemplate(source: string, dot: Value): string {
  return render(parse(source), dot);
}
