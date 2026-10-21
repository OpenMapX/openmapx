import { posix } from "node:path";

// Shared by the release planner and the Dockerfile workspace gate. Kept free of
// side effects and top-level await, so CommonJS-compiled scripts can load it.

/** Conservative coverage, not a second Docker parser. Unsupported constructs
 * expand to the whole context. Exclusions deliberately do not narrow coverage.
 * `*` and `?` globs stay patterns; other glob syntax widens to its directory. */
export function dockerInputs(dockerfile, context) {
  const fallback = [context];
  if (/^\s*#\s*escape\s*=/im.test(dockerfile) || /\bONBUILD\b|<<|--mount=/i.test(dockerfile))
    return fallback;
  const lines = dockerfile
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ");
  const inputs = [];
  for (const match of lines.matchAll(/^\s*(?:COPY|ADD)\s+(.+)$/gim)) {
    let args = match[1].trim();
    let fromStage = false;
    while (args.startsWith("--")) {
      const flag = args.match(
        /^--(from|chown|chmod|exclude|link|parents|checksum|keep-git-dir|unpack)(?:=([^\s]+))?\s+/,
      );
      if (!flag) return fallback;
      if (flag[1] === "from") fromStage = true;
      args = args.slice(flag[0].length);
    }
    if (fromStage) continue;
    let paths;
    try {
      paths = args.startsWith("[") ? JSON.parse(args) : args.split(/\s+/);
    } catch {
      return fallback;
    }
    if (!Array.isArray(paths) || paths.length < 2 || paths.some((path) => typeof path !== "string"))
      return fallback;
    for (let source of paths.slice(0, -1)) {
      if (/[\s$'"\\]/.test(source) || source.includes("://") || source.split("/").includes(".."))
        return fallback;
      source = source.replace(/^\/+/, "");
      if (/[[\]\\]/.test(source)) {
        const prefix = source.slice(0, source.search(/[*?[\]\\]/));
        source = prefix.endsWith("/") ? prefix.slice(0, -1) : posix.dirname(prefix);
      }
      inputs.push(posix.normalize(posix.join(context, source || ".")).replace(/\/$/, ""));
    }
  }
  return [...new Set(inputs)];
}

const globCache = new Map();
/** A `*`/`?` pattern matches within one path segment, like Docker's COPY. A
 * matched directory covers everything below it. */
function globPattern(input) {
  let pattern = globCache.get(input);
  if (!pattern) {
    const body = input
      .split("")
      .map((char) =>
        char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.+^${}()|\\]/g, "\\$&"),
      )
      .join("");
    pattern = new RegExp(`^${body}(?:/.*)?$`);
    globCache.set(input, pattern);
  }
  return pattern;
}

export function coversPath(inputs, path) {
  return inputs.some((input) =>
    /[*?]/.test(input)
      ? globPattern(input).test(path)
      : input === "." || path === input || path.startsWith(`${input}/`),
  );
}
