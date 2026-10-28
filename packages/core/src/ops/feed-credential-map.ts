const rejected = () => new Error("Feed credential map exceeds its format or budget");
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON strings must reject literal C0 control characters.
const token = /[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")[ \t\r\n]*/y;

/** Flat JSON parser intentionally retains keys until duplicates have been checked. */
function readMap(input: string): [string, string][] {
  let offset = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(input[offset] ?? "") && offset < input.length) offset++;
  };
  const take = (expected: string) => {
    whitespace();
    if (input[offset++] !== expected) throw rejected();
  };
  const string = () => {
    token.lastIndex = offset;
    const match = token.exec(input);
    if (!match) throw rejected();
    offset = token.lastIndex;
    return JSON.parse(match[1]!) as string;
  };
  take("{");
  const entries: [string, string][] = [];
  whitespace();
  if (input[offset] !== "}") {
    for (;;) {
      if (entries.length === 1000) throw rejected();
      const key = string();
      take(":");
      entries.push([key, string()]);
      if (input[offset] !== ",") break;
      offset++;
    }
  }
  take("}");
  whitespace();
  if (offset !== input.length) throw rejected();
  return entries;
}

/** Count every retained key, escaping and UTF-8 byte; never truncates or drops orphans. */
export function canonicalFeedCredentialMap(
  input: string | Readonly<Record<string, string>>,
): string {
  try {
    if (typeof input === "string" && (/[\uD800-\uDFFF]/u.test(input) || input.length > 262144))
      throw rejected();
    if (typeof input !== "string" && (!input || Array.isArray(input) || typeof input !== "object"))
      throw rejected();
    const entries = typeof input === "string" ? readMap(input) : Object.entries(input);
    if (entries.length > 1000) throw rejected();
    const keys = new Set<string>();
    for (const [key, value] of entries) {
      if (
        !key ||
        /[\uD800-\uDFFF]/u.test(key) ||
        [...key].length > 512 ||
        forbidden.has(key) ||
        keys.has(key) ||
        typeof value !== "string" ||
        /[\uD800-\uDFFF]/u.test(value) ||
        Buffer.byteLength(value, "utf8") > 8192
      )
        throw rejected();
      keys.add(key);
    }
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const canonical = `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",")}}`;
    if (Buffer.byteLength(canonical, "utf8") > 65536) throw rejected();
    return canonical;
  } catch {
    throw rejected();
  }
}
