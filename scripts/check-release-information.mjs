import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { canonicalPackageVersion } from "./canonical-package-version.mjs";

export const importantImpacts = ["breaking", "migration", "security", "operator-action"];
const globalInputs = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
  "tsconfig.base.json",
  "turbo.json",
  "LICENSE",
  "LICENSING.md",
]);
const notePath = (path) =>
  /^\.changeset\/[a-z0-9][a-z0-9-]*\.md$/.test(path) && path !== ".changeset/README.md";
const fragmentPath = (path) =>
  /^release-notes\/[a-z0-9][a-z0-9-]*\.md$/.test(path) && path !== "release-notes/README.md";
const testsOnly = (path) =>
  /(?:^|\/)(__tests__|__mocks__)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

export function git(cwd, ...args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, env, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
}
export function snapshot(cwd, ref) {
  const entries = new Map(
    git(cwd, "ls-tree", "-rz", ref)
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        return [path, { mode: meta.split(" ")[0], object: meta.split(" ")[2] }];
      }),
  );
  const cache = new Map();
  return {
    ref,
    entries,
    read(path) {
      if (!entries.has(path)) return null;
      if (!/^100(?:644|755)$/.test(entries.get(path).mode))
        throw new Error(`${path}: expected a regular tracked file`);
      if (!cache.has(path)) cache.set(path, git(cwd, "show", `${ref}:${path}`));
      return cache.get(path);
    },
    json(path) {
      const value = this.read(path);
      return value === null ? null : JSON.parse(value.toString());
    },
  };
}
function yaml(source, path) {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length)
    throw new Error(
      `${path}: invalid YAML: ${[...doc.errors, ...doc.warnings].map((e) => e.message).join("; ")}`,
    );
  return doc.toJS({ maxAliasCount: 0 });
}
function frontmatter(contents, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(contents);
  if (!match) throw new Error(`${path}: expected YAML frontmatter and a non-empty explanation`);
  return { data: yaml(match[1], path), body: match[2] };
}
function prose(body) {
  const lines = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/);
  const visible = [];
  let fence = null;
  for (const line of lines) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = open[1];
      continue;
    }
    visible.push(line);
  }
  return visible.join("\n");
}
function meaningful(value, min = 12) {
  return (
    typeof value === "string" &&
    value.trim().length >= min &&
    !/^(?:todo|tbd|n\/?a|none|no changes?|placeholder|\.{3}|<[^>]+>)\W*$/i.test(value.trim())
  );
}
function section(body, title) {
  const lines = prose(body).split(/\r?\n/);
  const heading = (line) =>
    /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line)?.[1]?.trim().toLowerCase();
  if (lines.filter((line) => heading(line) === title.toLowerCase()).length > 1)
    throw new Error(`Duplicate ${title} sections are ambiguous`);
  const out = [];
  let collecting = false;
  for (const line of lines) {
    if (heading(line) !== undefined || /^ {0,3}#[ \t]+/.test(line)) {
      if (collecting) break;
      collecting = heading(line) === title.toLowerCase();
      continue;
    }
    if (collecting) out.push(line);
  }
  return out.join("\n");
}
export function readDisposition(body) {
  const text = section(body, "Release and upgrade impact");
  for (const label of ["No package release:", "Product impact:", "Package release:"])
    if (
      text.split(/\r?\n/).filter((line) => line.toLowerCase().startsWith(label.toLowerCase()))
        .length > 1
    )
      throw new Error(`Duplicate ${label} declaration`);
  const reason = /^No package release:\s*(.+)$/im.exec(text)?.[1]?.trim();
  const product = /^Product impact:\s*(.+)$/im.exec(text)?.[1]?.trim().toLowerCase();
  const version = /^Package release:\s*version\s*$/im.test(text);
  const impacts = product ? product.split(",").map((x) => x.trim()) : [];
  if (
    impacts.some((x) => !["none", "ordinary", ...importantImpacts].includes(x)) ||
    new Set(impacts).size !== impacts.length ||
    (impacts.length > 1 && impacts.some((x) => ["none", "ordinary"].includes(x)))
  )
    throw new Error(
      "Product impact must be none, ordinary, or a comma-separated list of breaking, migration, security, operator-action",
    );
  return { reason: meaningful(reason, 24) ? reason : null, impacts, version };
}
export function publicPackages(state) {
  const config = state.json("release/public-packages.json");
  if (config?.schemaVersion !== 1 || !Array.isArray(config.packages) || !config.packages.length)
    throw new Error("Missing or invalid release/public-packages.json");
  const names = new Set();
  const directories = new Set();
  for (const item of config.packages) {
    if (
      typeof item.name !== "string" ||
      !/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(item.name) ||
      typeof item.directory !== "string" ||
      !/^[a-z0-9-]+(?:\/[a-z0-9-]+)+$/.test(item.directory) ||
      typeof item.bundleWorkspaceDependencies !== "boolean" ||
      (item.versionedSchemas !== undefined && !/^[a-z0-9-]+$/.test(item.versionedSchemas)) ||
      names.has(item.name) ||
      directories.has(item.directory)
    )
      throw new Error("Invalid or duplicate public-package entry");
    const manifest = state.json(`${item.directory}/package.json`);
    if (!manifest || manifest.name !== item.name || manifest.private === true)
      throw new Error(
        `${item.name}: allowlisted package must have a matching non-private manifest`,
      );
    names.add(item.name);
    directories.add(item.directory);
  }
  return config.packages;
}
function workspacePackages(state) {
  const config = yaml(state.read("pnpm-workspace.yaml")?.toString() ?? "", "pnpm-workspace.yaml");
  if (!Array.isArray(config?.packages)) throw new Error("Expected workspace package patterns");
  return new Map(
    [...state.entries.keys()]
      .filter(
        (path) =>
          path.endsWith("/package.json") &&
          config.packages.some((pattern) => matchesGlob(path.slice(0, -13), pattern)),
      )
      .map((path) => {
        const manifest = state.json(path);
        return [manifest.name, { directory: path.slice(0, -13), manifest }];
      }),
  );
}
function sourceDirectories(item, state) {
  const workspaces = workspacePackages(state);
  const dirs = new Set([item.directory]);
  if (!item.bundleWorkspaceDependencies) return dirs;
  const seen = new Set();
  function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const entry = workspaces.get(name);
    if (!entry) return;
    dirs.add(entry.directory);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ])
      for (const dep of Object.keys(entry.manifest[field] ?? {}))
        if (workspaces.has(dep)) visit(dep);
  }
  visit(item.name);
  return dirs;
}
function explicitlyShipped(item, state, path) {
  if (!path.startsWith(`${item.directory}/`)) return false;
  const relative = path.slice(item.directory.length + 1);
  const files = state.json(`${item.directory}/package.json`)?.files ?? [];
  const matches = (pattern) =>
    relative === pattern ||
    relative.startsWith(`${pattern.replace(/\/$/, "")}/`) ||
    matchesGlob(relative, pattern);
  return (
    files.some((pattern) => !pattern.startsWith("!") && matches(pattern)) &&
    !files.some((pattern) => pattern.startsWith("!") && matches(pattern.slice(1)))
  );
}
export function contributionCheck({ before, after, changed, body }) {
  const errors = [];
  const disposition = readDisposition(body);
  const packages = new Map();
  const shipped = new Set();
  for (const state of [before, after]) {
    if (!state.entries.has("release/public-packages.json")) continue;
    for (const item of publicPackages(state)) {
      for (const path of changed) if (explicitlyShipped(item, state, path)) shipped.add(path);
      if (!packages.has(item.name)) packages.set(item.name, new Set());
      for (const dir of sourceDirectories(item, state)) packages.get(item.name).add(dir);
    }
  }
  if (!packages.size) throw new Error("No qualified public packages configured");
  const affected = [...packages]
    .filter(([, dirs]) =>
      changed.some(
        (path) =>
          (!testsOnly(path) || shipped.has(path)) &&
          (globalInputs.has(path) || [...dirs].some((dir) => path.startsWith(`${dir}/`))),
      ),
    )
    .map(([name]) => name);
  for (const path of changed) {
    if (
      path.startsWith(".changeset/") &&
      path.endsWith(".md") &&
      path !== ".changeset/README.md" &&
      !notePath(path)
    )
      throw new Error(`${path}: use a lowercase hyphenated Changeset filename`);
    if (
      path.startsWith("release-notes/") &&
      path.endsWith(".md") &&
      path !== "release-notes/README.md" &&
      !fragmentPath(path)
    )
      throw new Error(`${path}: use a lowercase hyphenated product fragment filename`);
  }
  const coverage = new Set();
  for (const path of changed.filter(notePath)) {
    const contents = after.read(path);
    if (!contents) {
      if (!disposition.reason)
        errors.push(
          `${path}: pending Changeset removed; use a canonical version PR or explain a separately reviewed queue reconciliation`,
        );
      continue;
    }
    const { data, body: summary } = frontmatter(contents.toString(), path);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !Object.keys(data).length ||
      !meaningful(prose(summary))
    )
      throw new Error(`${path}: empty bookkeeping Changesets are not allowed`);
    for (const [name, bump] of Object.entries(data)) {
      if (!packages.has(name) || !["patch", "minor", "major"].includes(bump))
        throw new Error(`${path}: invalid bump or unqualified package ${name}`);
      coverage.add(name);
    }
  }
  for (const name of affected)
    if (!coverage.has(name) && !disposition.reason)
      errors.push(
        `${name}: delivered artifact may change; add a covering Changeset or a justified No package release: explanation in the PR's Release and upgrade impact section`,
      );
  const required = new Set(disposition.impacts.filter((x) => importantImpacts.includes(x)));
  if (changed.some((path) => /^apps\/api\/src\/db\/migrations\/.*\.sql$/.test(path)))
    required.add("migration");
  const covered = new Set();
  for (const path of changed.filter(fragmentPath)) {
    const contents = after.read(path);
    if (!contents) continue;
    const { data, body: details } = frontmatter(contents.toString(), path);
    if (
      !data ||
      !Array.isArray(data.impacts) ||
      !data.impacts.length ||
      Object.keys(data).some((k) => k !== "impacts") ||
      new Set(data.impacts).size !== data.impacts.length ||
      data.impacts.some((x) => !importantImpacts.includes(x))
    )
      throw new Error(
        `${path}: impacts must list breaking, migration, security or operator-action`,
      );
    for (const title of ["What changes", "Who is affected", "Required action"])
      if (!meaningful(section(details, title)))
        throw new Error(`${path}: missing meaningful ${title} section`);
    for (const impact of data.impacts) covered.add(impact);
  }
  if (covered.size && disposition.impacts.some((x) => ["none", "ordinary"].includes(x)))
    errors.push("Product impact declaration contradicts the committed important product fragment");
  for (const impact of required)
    if (!covered.has(impact))
      errors.push(
        `Product ${impact} impact requires a committed release-notes fragment with change, audience and required action`,
      );
  return { errors, affected, reason: disposition.reason, version: disposition.version };
}

function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string", default: process.cwd() },
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      "pr-json": { type: "string" },
      "body-file": { type: "string" },
    },
    strict: true,
  });
  if (!values.base) throw new Error("--base is required");
  const cwd = resolve(values.cwd);
  const head = git(cwd, "rev-parse", "--verify", "--end-of-options", `${values.head}^{commit}`)
    .toString()
    .trim();
  const requestedBase = git(
    cwd,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values.base}^{commit}`,
  )
    .toString()
    .trim();
  let body = values["body-file"] ? readFileSync(values["body-file"], "utf8") : "";
  if (values["pr-json"]) {
    const pr = JSON.parse(readFileSync(values["pr-json"], "utf8"));
    if (pr.head?.sha !== head)
      throw new Error(
        "PR metadata head does not match the checked head; refresh metadata and rerun",
      );
    if (pr.base?.sha !== requestedBase)
      throw new Error(
        "PR metadata base does not match the comparison base; refresh metadata and rerun",
      );
    body = pr.body ?? "";
  }
  const base = git(cwd, "merge-base", requestedBase, head).toString().trim();
  const before = snapshot(cwd, base);
  const after = snapshot(cwd, head);
  const changed = git(cwd, "diff", "--no-renames", "--name-only", "-z", base, head)
    .toString()
    .split("\0")
    .filter(Boolean);
  const packages = publicPackages(
    before.entries.has("release/public-packages.json") ? before : after,
  );
  const versionDelta = packages.some(
    (item) =>
      before.json(`${item.directory}/package.json`)?.version !==
      after.json(`${item.directory}/package.json`)?.version,
  );
  const disposition = readDisposition(body);
  const canonical = disposition.version || versionDelta;
  if (canonical && disposition.impacts.some((impact) => importantImpacts.includes(impact)))
    throw new Error(
      "A canonical version-only batch cannot declare new important product impact; commit the product fragment in its separate contribution first",
    );
  const result = canonical
    ? canonicalPackageVersion({
        cwd,
        before,
        after,
        changed,
        packages,
        git,
        validatePending() {
          const pending = [...before.entries.keys()].filter(notePath);
          if (!pending.length)
            throw new Error("Canonical version batch has no pending qualified Changesets");
          const validation = contributionCheck({
            before,
            after: before,
            changed: pending,
            body: "",
          });
          if (validation.errors.length) throw new Error(validation.errors.join("\n"));
        },
      })
    : contributionCheck({ before, after, changed, body });
  if (result.errors.length) throw new Error(result.errors.join("\n"));
  console.log(
    `Release information valid. Affected public artifacts: ${result.affected.join(", ") || "none"}.`,
  );
  if (result.reason)
    console.log(`Maintainer review required for no-release rationale: ${result.reason}`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
