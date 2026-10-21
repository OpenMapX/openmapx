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

/** Splits a Dockerfile into its build stages, in order. */
export function dockerStages(dockerfile) {
  const lines = dockerfile
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .split("\n");
  const stages = [];
  for (const line of lines) {
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (from) {
      stages.push({ name: from[2]?.toLowerCase(), base: from[1].toLowerCase(), lines: [] });
      continue;
    }
    stages.at(-1)?.lines.push(line);
  }
  return stages.map(({ name, base, lines }) => ({ name, base, text: lines.join("\n") }));
}

/**
 * Context inputs of the stages the final stage is built from, following `FROM
 * <stage>` and `COPY --from=<stage>`, without entering the `replaced` stage.
 * A caller accounts for that stage's output itself.
 */
export function stageInputs(dockerfile, context, replaced) {
  const stages = dockerStages(dockerfile);
  const byName = new Map(stages.filter((stage) => stage.name).map((stage) => [stage.name, stage]));
  const visited = new Set();
  const inputs = new Set();
  let reachesReplaced = false;
  const visit = (stage) => {
    if (visited.has(stage)) return;
    visited.add(stage);
    for (const input of dockerInputs(stage.text, context)) inputs.add(input);
    const dependencies = [
      stage.base,
      ...[...stage.text.matchAll(/^\s*COPY\s+.*--from=(\S+)/gim)].map((match) => match[1]),
    ];
    for (const dependency of dependencies) {
      const name = dependency.toLowerCase();
      if (name === replaced) reachesReplaced = true;
      else if (byName.has(name)) visit(byName.get(name));
    }
  };
  if (stages.length > 0) visit(stages.at(-1));
  return { inputs: [...inputs], reachesReplaced };
}
