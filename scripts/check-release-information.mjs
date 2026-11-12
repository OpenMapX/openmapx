import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseAllDocuments, parseDocument } from "yaml";
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
export const testsOnly = (path) =>
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
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies"];
const productionFields = ["dependencies", "optionalDependencies"];
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/**
 * A manifest edit confined to its dependency objects is fully reflected in the
 * lockfile's importer for that directory, so the lockfile closure can judge it.
 * Key order is kept in the comparison because some fields, such as conditional
 * exports, are order-sensitive. A manifest that is missing on one side, not a
 * regular file or not a JSON object is not a dependency-only change.
 */
function dependencyOnlyChange(before, after, path) {
  try {
    const sides = [before.read(path), after.read(path)];
    if (sides.includes(null)) return false;
    const [a, b] = sides.map((bytes) => {
      const manifest = JSON.parse(bytes.toString());
      if (!plainObject(manifest)) throw new Error(`${path}: expected a JSON object`);
      for (const field of dependencyFields) delete manifest[field];
      return JSON.stringify(manifest);
    });
    return a === b;
  } catch {
    return false;
  }
}
/**
 * Splits a pnpm v9 lockfile into its package-manager document (when present)
 * and the workspace project document.
 */
function lockfileDocuments(state) {
  const source = state.read("pnpm-lock.yaml");
  if (source === null) throw new Error("pnpm-lock.yaml is missing");
  const docs = parseAllDocuments(source.toString(), { uniqueKeys: true });
  if (!Array.isArray(docs) || !docs.length) throw new Error("pnpm-lock.yaml has no documents");
  for (const doc of docs)
    if (doc.errors.length || doc.warnings.length)
      throw new Error(
        `pnpm-lock.yaml: invalid YAML: ${[...doc.errors, ...doc.warnings].map((e) => e.message).join("; ")}`,
      );
  const values = docs.map((doc) => doc.toJS({ maxAliasCount: 0 }));
  if (values.length > 2) throw new Error("pnpm-lock.yaml has unexpected documents");
  const project = values.at(-1);
  const environment = values.length === 2 ? values[0] : null;
  if (
    environment &&
    (!plainObject(environment.importers) || Object.keys(environment.importers).join() !== ".")
  )
    throw new Error("pnpm-lock.yaml: unexpected package-manager document");
  if (
    !plainObject(project) ||
    !plainObject(project.importers) ||
    !["packages", "snapshots"].every(
      (key) => project[key] === undefined || plainObject(project[key]),
    )
  )
    throw new Error("pnpm-lock.yaml: expected workspace importers");
  return { environment, project };
}
/** Everything in the lockfile that applies to the whole workspace rather than one package. */
function lockfileWideInputs({ environment, project }) {
  const { importers, packages, snapshots, ...settings } = project;
  return JSON.stringify({ environment, settings });
}
const snapshotKey = (name, version) =>
  version.split("(")[0].indexOf("@", 1) > 0 ? version : `${name}@${version}`;
/** The peer dependency names a workspace package declares in its manifest at this commit. */
function declaredPeers(state, directory) {
  const path = directory === "." ? "package.json" : `${directory}/package.json`;
  let manifest;
  try {
    manifest = state.json(path);
  } catch (error) {
    throw new Error(`${path}: unreadable manifest (${error.message})`);
  }
  if (
    !plainObject(manifest) ||
    (manifest.peerDependencies !== undefined && !plainObject(manifest.peerDependencies))
  )
    throw new Error(`${path}: missing or invalid manifest`);
  return new Set(Object.keys(manifest.peerDependencies ?? {}));
}
/**
 * Resolves every lockfile snapshot a package's build can use: its own importer's
 * dependencies (including build tools); for linked workspace packages, their
 * production dependencies and the devDependencies that provide their declared
 * peers (their runtime imports); and all transitive snapshot dependencies.
 */
function dependencyTree({ project }, directory, state) {
  const { importers, packages = {}, snapshots = {} } = project;
  const tree = { importers: {}, snapshots: {}, packages: {} };
  const pending = [];
  const follow = (from, name, version) => {
    if (typeof version !== "string" || !version)
      throw new Error(`${name}: missing resolved version`);
    if (!version.startsWith("link:")) return pending.push(snapshotKey(name, version));
    const target = posix.normalize(posix.join(from, version.slice(5)));
    if (target === ".." || target.startsWith("../") || posix.isAbsolute(target))
      throw new Error(`${name}: link outside the workspace`);
    visit(target, true);
  };
  const visit = (path, linked) => {
    if (Object.hasOwn(tree.importers, path)) return;
    const importer = importers[path];
    if (!plainObject(importer)) throw new Error(`missing importer ${path}`);
    const entry = {};
    tree.importers[path] = entry;
    for (const [key, value] of Object.entries(importer))
      if (!dependencyFields.includes(key)) entry[key] = value;
    const peers = linked ? declaredPeers(state, path) : null;
    for (const field of dependencyFields) {
      if (importer[field] === undefined) continue;
      if (!plainObject(importer[field])) throw new Error(`${path}: invalid ${field}`);
      const followed = Object.entries(importer[field]).filter(
        ([name]) => !linked || field !== "devDependencies" || peers.has(name),
      );
      if (!followed.length) continue;
      entry[field] = {};
      for (const [name, value] of followed) {
        entry[field][name] = value?.version;
        follow(path, name, value?.version);
      }
    }
  };
  visit(directory, false);
  while (pending.length) {
    const key = pending.pop();
    if (Object.hasOwn(tree.snapshots, key)) continue;
    const snapshot = snapshots[key];
    const id = key.includes("(") ? key.slice(0, key.indexOf("(")) : key;
    if (!plainObject(snapshot) || !plainObject(packages[id]))
      throw new Error(`missing lockfile entry ${key}`);
    tree.snapshots[key] = snapshot;
    tree.packages[id] = packages[id];
    for (const field of productionFields) {
      if (snapshot[field] === undefined) continue;
      if (!plainObject(snapshot[field])) throw new Error(`${key}: invalid ${field}`);
      for (const [name, version] of Object.entries(snapshot[field])) follow(".", name, version);
    }
  }
  return JSON.stringify(tree);
}
/** Parses the lockfile at both commits, keeping a parse failure as a value. */
function parseLockfiles(before, after) {
  return [before, after].map((state) => {
    try {
      return { lockfile: lockfileDocuments(state) };
    } catch (error) {
      return { error };
    }
  });
}
/**
 * Decides, per public package, whether a dependency-only change can reach its
 * build. Anything that cannot be resolved counts as a change.
 */
function dependencyTreeChanges(states, items, refs) {
  const failure = states.find((state) => state.error)?.error;
  if (!failure && lockfileWideInputs(states[0].lockfile) !== lockfileWideInputs(states[1].lockfile))
    return new Map(
      [...items.keys()].map((name) => [name, "lockfile-wide settings changed; treated as changed"]),
    );
  return new Map(
    [...items].map(([name, sides]) => {
      try {
        if (failure) throw failure;
        if (!sides.before || !sides.after) throw new Error("not present at both commits");
        const trees = states.map((state, index) =>
          dependencyTree(state.lockfile, [sides.before, sides.after][index].directory, refs[index]),
        );
        return [name, trees[0] === trees[1] ? null : "resolved dependency tree changed"];
      } catch (error) {
        return [name, `resolved dependency tree unknown (${error.message}); treated as changed`];
      }
    }),
  );
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
  const config = state.json("scripts/public-packages.json");
  if (config?.schemaVersion !== 1 || !Array.isArray(config.packages) || !config.packages.length)
    throw new Error("Missing or invalid scripts/public-packages.json");
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
export function workspacePackages(state) {
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
export function sourceDirectories(item, state) {
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
  const items = new Map();
  const shipped = new Set();
  const publicManifests = new Set();
  for (const [side, state] of [
    ["before", before],
    ["after", after],
  ]) {
    if (!state.entries.has("scripts/public-packages.json")) continue;
    for (const item of publicPackages(state)) {
      for (const path of changed) if (explicitlyShipped(item, state, path)) shipped.add(path);
      if (!packages.has(item.name)) packages.set(item.name, new Set());
      for (const dir of sourceDirectories(item, state)) packages.get(item.name).add(dir);
      if (!items.has(item.name)) items.set(item.name, { before: null, after: null });
      items.get(item.name)[side] = item;
      publicManifests.add(`${item.directory}/package.json`);
    }
  }
  if (!packages.size) throw new Error("No qualified public packages configured");
  let lockfiles;
  const parsedLockfiles = () => {
    lockfiles ??= parseLockfiles(before, after);
    return lockfiles;
  };
  // Only a manifest with a lockfile importer at both commits is fully reflected
  // in the lockfile. A public package's own manifest is always packed (and the
  // CLI bundles it), and shipped manifests such as scaffold templates reach
  // consumers verbatim, so both stay under the path rule.
  const importerAtBoth = (directory) =>
    parsedLockfiles().every(
      ({ lockfile }) => lockfile && Object.hasOwn(lockfile.project.importers, directory),
    );
  const byTree = new Set(
    changed.filter(
      (path) =>
        path === "pnpm-lock.yaml" ||
        ((path === "package.json" ||
          (path.endsWith("/package.json") && !publicManifests.has(path) && !shipped.has(path))) &&
          dependencyOnlyChange(before, after, path) &&
          importerAtBoth(path === "package.json" ? "." : path.slice(0, -"/package.json".length))),
    ),
  );
  const treeChanges = byTree.size
    ? dependencyTreeChanges(parsedLockfiles(), items, [before, after])
    : new Map();
  const notes = [...treeChanges].map(
    ([name, change]) => `${name}: ${change ?? "resolved dependency tree unchanged"}`,
  );
  const affected = [...packages]
    .filter(
      ([name, dirs]) =>
        treeChanges.get(name) ||
        changed.some(
          (path) =>
            !byTree.has(path) &&
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
  return { errors, affected, notes, reason: disposition.reason, version: disposition.version };
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
    before.entries.has("scripts/public-packages.json") ? before : after,
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
  for (const note of result.notes ?? []) console.log(note);
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
