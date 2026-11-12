import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, resolve } from "node:path";
import ts from "typescript";
import {
  lockfileDocuments,
  publicPackages,
  resolveDependencyTree,
  sourceDirectories,
  testsOnly,
  workspacePackages,
} from "./check-release-information.mjs";

const codeFile = /\.[cm]?[jt]sx?$/;
/** esbuild's default resolve extensions, which tsup keeps. */
const resolveExtensions = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];
/** esbuild also resolves a JavaScript specifier to the TypeScript file it was compiled from. */
const typeScriptSources = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const buildConfig = /^tsup\.config\.[cm]?[jt]s$/;
/**
 * Files inside checked directories that no public build bundles, besides each
 * public package's own tsup configuration (which tsup executes and whose
 * dependencies are the public package's build toolchain). A checked file,
 * manifest entry or subpath import that resolves to one of them fails.
 */
export const toolingFiles = [
  {
    path: "packages/extension-contracts/scripts/schemas.mjs",
    reason:
      "the schema generator and checker runs with node from the package scripts; no tsup entry lists it",
  },
];
/**
 * Non-literal dynamic imports and requires that may stay, matched by file and
 * by the exact argument expression, each with the reason it cannot pull an
 * undeclared package into a public artifact.
 */
export const dynamicImportAllowlist = [];

/** The working tree's tracked and unignored files, read like a Git snapshot. */
export function worktreeState(cwd) {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd, maxBuffer: 64 * 1024 * 1024 },
  )
    .toString()
    .split("\0")
    .filter((path) => path && existsSync(join(cwd, path)));
  const entries = new Map(paths.map((path) => [path, {}]));
  return {
    entries,
    read(path) {
      if (!entries.has(path)) return null;
      // The build follows a symbolic link and resolves the target's imports
      // from the target's directory, so a link would be checked in the wrong
      // place.
      if (lstatSync(join(cwd, path)).isSymbolicLink())
        throw new Error(`${path}: symbolic links are not allowed in checked sources`);
      return readFileSync(join(cwd, path));
    },
    json(path) {
      const value = this.read(path);
      return value === null ? null : JSON.parse(value.toString());
    },
  };
}

/**
 * Every module reference in a source file, with type-only and non-literal
 * forms marked. A file containing JSX also references the automatic JSX
 * runtime the build injects: `react/jsx-runtime`, or the package a leading
 * `@jsxImportSource` pragma names. A tsconfig `jsxImportSource` is rejected
 * separately, so no other source applies.
 */
export function moduleReferences(path, source) {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const references = [];
  const lineOf = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const add = (node, argument, typeOnly) => {
    const literal =
      argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument));
    references.push({
      specifier: literal ? argument.text : null,
      expression: literal ? null : (argument?.getText(file) ?? ""),
      typeOnly,
      line: lineOf(node),
    });
  };
  const isRequire = (expression) =>
    (ts.isIdentifier(expression) && expression.text === "require") ||
    (ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "require" &&
      expression.name.text === "resolve");
  let jsx = null;
  const visit = (node) => {
    if (ts.isImportDeclaration(node))
      add(node, node.moduleSpecifier, node.importClause?.isTypeOnly === true);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      add(node, node.moduleSpecifier, node.isTypeOnly);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node, node.moduleReference.expression, node.isTypeOnly);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression))
    )
      add(node, node.arguments[0], false);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node, node.argument.literal, true);
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      if (!node.name.text.includes("*")) add(node, node.name, true);
    } else if (
      !jsx &&
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
    )
      jsx = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (jsx) {
    const pragma = (ts.getLeadingCommentRanges(source, 0) ?? [])
      .map((range) => /@jsxImportSource\s+(\S+)/.exec(source.slice(range.pos, range.end))?.[1])
      .find(Boolean);
    references.push({
      specifier: `${pragma ?? "react"}/jsx-runtime`,
      expression: null,
      typeOnly: false,
      line: lineOf(jsx),
    });
  }
  return references;
}

const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const typesPackage = (name) =>
  `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
/** The string targets of a package.json `exports`/`imports` value, through conditions and arrays. */
const targets = (value) =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(targets)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(targets)
        : [];
/** The targets of the manifest `imports` entries that match a `#` specifier, with patterns applied. */
function subpathImportTargets(manifest, specifier) {
  const matches = [];
  for (const [key, value] of Object.entries(manifest.imports ?? {})) {
    const star = key.indexOf("*");
    if (star < 0) {
      if (key === specifier) matches.push(...targets(value));
      continue;
    }
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      const part = specifier.slice(prefix.length, specifier.length - suffix.length);
      matches.push(...targets(value).map((target) => target.replaceAll("*", part)));
    }
  }
  return matches;
}

/**
 * Checks that the directories the release check treats as a public package's
 * source import only packages their own manifest declares, and that nothing
 * bundled is hidden from this check or from the release check's path rule.
 * The release check's dependency trees follow declared dependencies only; an
 * import that resolves through the root manifest or through hoisting would
 * escape them.
 *
 * In a public package's own directory any installed dependency is accepted,
 * because its whole importer is part of the tree. In a workspace package the
 * CLI bundles, runtime imports must be production or optional dependencies, or
 * peers provided by a devDependency (which the tree follows).
 */
export function declaredImportViolations({
  cwd = process.cwd(),
  allowlist = dynamicImportAllowlist,
  tooling = toolingFiles,
} = {}) {
  const state = worktreeState(cwd);
  const entries = [...state.entries.keys()].sort();
  const directories = new Set();
  for (const path of entries)
    for (
      let dir = posix.dirname(path);
      dir !== "." && !directories.has(dir);
      dir = posix.dirname(dir)
    )
      directories.add(dir);
  const manifests = new Map(
    [...workspacePackages(state).values()].map(({ directory, manifest }) => [directory, manifest]),
  );
  const violations = [];
  const items = publicPackages(state);
  const bundled = new Map();
  for (const item of items) {
    const sources = sourceDirectories(item, state);
    for (const directory of sources)
      bundled.set(directory, bundled.get(directory) || directory !== item.directory);
    // The release check's path rule sees only these directories, so the tree may
    // not link a workspace package outside them (for example through an override).
    try {
      const tree = resolveDependencyTree(lockfileDocuments(state), item.directory, state);
      for (const path of Object.keys(tree.importers))
        if (!sources.has(path))
          violations.push(
            `${item.name}: the lockfile links ${path} into its dependency tree, but no manifest in its source directories declares it`,
          );
    } catch (error) {
      violations.push(`${item.name}: dependency tree cannot be resolved (${error.message})`);
    }
  }
  const excluded = new Set(
    items.flatMap((item) =>
      entries.filter(
        (path) =>
          path.startsWith(`${item.directory}/`) &&
          buildConfig.test(path.slice(item.directory.length + 1)),
      ),
    ),
  );
  for (const { path } of tooling) {
    if (!state.entries.has(path)) violations.push(`${path}: excluded tooling file does not exist`);
    excluded.add(path);
  }
  const skipped = (path) => excluded.has(path) || testsOnly(path);
  for (const path of entries)
    if (
      /(?:^|\/)tsconfig[^/]*\.json$/.test(path) &&
      (!path.includes("/") || [...bundled.keys()].some((dir) => path.startsWith(`${dir}/`)))
    ) {
      const { config, error } = ts.parseConfigFileTextToJson(path, state.read(path).toString());
      if (error || config?.compilerOptions?.jsxImportSource !== undefined)
        violations.push(`${path}: jsxImportSource is not supported by the declared-imports check`);
    }

  /** Every tracked file esbuild could resolve a path to: exact, extensions, TypeScript sources, directory entry points. */
  const resolveFiles = (target, depth = 0) => {
    const files = new Set();
    const extension = posix.extname(target);
    for (const candidate of [
      target,
      ...(typeScriptSources[extension] ?? []).map(
        (replacement) => target.slice(0, -extension.length) + replacement,
      ),
      ...resolveExtensions.map((ext) => target + ext),
    ])
      if (state.entries.has(candidate)) files.add(candidate);
    if (directories.has(target)) {
      let nested = null;
      try {
        nested = state.json(`${target}/package.json`);
      } catch {
        files.add(`${target}/package.json`);
      }
      if (depth < 8)
        for (const field of ["module", "main"])
          if (typeof nested?.[field] === "string")
            for (const file of resolveFiles(posix.join(target, nested[field]), depth + 1))
              files.add(file);
      for (const ext of resolveExtensions)
        if (state.entries.has(`${target}/index${ext}`)) files.add(`${target}/index${ext}`);
    }
    return [...files];
  };
  /** A path inside a checked package: it must stay inside, avoid node_modules and resolve only to checked files. */
  const checkLocal = (where, directory, label, target) => {
    const relative = posix.relative(directory, target);
    if (target.split("/").includes("node_modules"))
      return violations.push(`${where}: ${label} reaches into node_modules`);
    if (relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative))
      return violations.push(
        `${where}: ${label} leaves ${directory}; import workspace packages by name`,
      );
    if (target.includes("*")) {
      const [prefix, suffix] = target.split("*");
      for (const file of entries)
        if (
          file.length >= prefix.length + suffix.length &&
          file.startsWith(prefix) &&
          file.endsWith(suffix) &&
          skipped(file)
        )
          violations.push(`${where}: ${label} matches ${file}, which this check skips`);
      return;
    }
    const files = resolveFiles(target);
    if (!files.length)
      return violations.push(`${where}: ${label} does not resolve to a tracked file`);
    for (const file of files)
      if (skipped(file))
        violations.push(`${where}: ${label} resolves to ${file}, which this check skips`);
  };

  for (const [directory, linked] of [...bundled].sort(([a], [b]) => a.localeCompare(b))) {
    const manifest = manifests.get(directory);
    if (!manifest) {
      violations.push(`${directory}: no workspace manifest`);
      continue;
    }
    const names = (field) => new Set(Object.keys(manifest[field] ?? {}));
    const development = names("devDependencies");
    const peers = names("peerDependencies");
    // A peer resolves inside the workspace only when a dependency field also
    // installs it there; otherwise the build finds it only through hoisting.
    const production = new Set([
      ...names("dependencies"),
      ...names("optionalDependencies"),
      ...[...peers].filter((name) => development.has(name)),
    ]);
    const checkPackage = (where, specifier, typeOnly) => {
      if (specifier.startsWith("node:") || builtinModules.includes(specifier)) return;
      const name = packageName(specifier);
      // A type-only reference may be served by the package's DefinitelyTyped types.
      const declaredIn = (set) => set.has(name) || (typeOnly && set.has(typesPackage(name)));
      if (name === manifest.name || declaredIn(production)) return;
      // Types are erased from the CLI bundle, so bundled workspace sources may
      // take them from devDependencies.
      if (declaredIn(development) && (!linked || typeOnly)) return;
      violations.push(
        declaredIn(development)
          ? `${where}: "${name}" is only a devDependency of ${directory}, which a public package bundles; declare it in dependencies, optionalDependencies, or as a peer with that devDependency providing it`
          : peers.has(name)
            ? `${where}: "${name}" is only a peerDependency of ${directory} and nothing installs it there; add the providing version to devDependencies`
            : `${where}: "${name}" is not declared in ${directory}/package.json`,
      );
    };
    // Importing the package by name resolves through these entry points.
    for (const field of ["exports", "main", "module"])
      for (const target of targets(manifest[field])) {
        const where = `${directory}/package.json ${field}`;
        if (field === "exports" && !target.startsWith("./"))
          violations.push(`${where}: "${target}" must start with ./`);
        else checkLocal(where, directory, `"${target}"`, posix.join(directory, target));
      }
    for (const path of entries) {
      if (!path.startsWith(`${directory}/`) || !codeFile.test(path) || skipped(path)) continue;
      for (const { specifier, expression, typeOnly, line } of moduleReferences(
        path,
        state.read(path).toString(),
      )) {
        const where = `${path}:${line}`;
        if (specifier === null) {
          if (!allowlist.some((entry) => entry.path === path && entry.expression === expression))
            violations.push(`${where}: non-literal dynamic import or require (${expression})`);
        } else if (specifier.startsWith(".")) {
          checkLocal(
            where,
            directory,
            `"${specifier}"`,
            posix.join(posix.dirname(path), specifier),
          );
        } else if (specifier.startsWith("/")) {
          violations.push(`${where}: absolute import "${specifier}"`);
        } else if (specifier.startsWith("#")) {
          const matches = subpathImportTargets(manifest, specifier);
          if (!matches.length)
            violations.push(`${where}: "${specifier}" has no imports entry in its manifest`);
          for (const target of matches) {
            const label = `"${specifier}" (imports target "${target}")`;
            if (target.startsWith("./"))
              checkLocal(where, directory, label, posix.join(directory, target));
            else if (target.startsWith(".") || target.startsWith("/") || target.startsWith("#"))
              violations.push(`${where}: ${label} is not a package or ./ path`);
            else checkPackage(where, target, typeOnly);
          }
        } else checkPackage(where, specifier, typeOnly);
      }
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const violations = declaredImportViolations();
  if (violations.length) {
    console.error(
      `Public package sources import undeclared packages:\n${violations.join("\n")}\nDeclare each package in the importing workspace's package.json.`,
    );
    process.exitCode = 1;
  } else console.log("Public package sources import only declared packages.");
}
