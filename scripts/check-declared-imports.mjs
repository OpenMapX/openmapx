import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, resolve } from "node:path";
import ts from "typescript";
import {
  publicPackages,
  sourceDirectories,
  testsOnly,
  workspacePackages,
} from "./check-release-information.mjs";

const codeFile = /\.[cm]?[jt]sx?$/;
/**
 * Files inside a checked package directory that no public build bundles. A
 * checked file that imports one of them fails the check, so an exclusion
 * cannot hide bundled code.
 */
const tooling = [
  // Build and test runner configuration (tsup.config.ts) is executed by the
  // tool; its own dependencies belong to the build toolchain, which the release
  // check takes from the public package's importer.
  /^[^/]+\.config\.[cm]?[jt]s$/,
  // Package maintenance scripts (extension-contracts' schema generator) run with
  // node; no build entry point lists them.
  /^scripts\//,
];
/**
 * Non-literal dynamic imports and requires that may stay, each with the reason
 * it cannot pull an undeclared package into a public artifact.
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
      return entries.has(path) ? readFileSync(join(cwd, path)) : null;
    },
    json(path) {
      const value = this.read(path);
      return value === null ? null : JSON.parse(value.toString());
    },
  };
}

/** Every module reference in a source file, with type-only and dynamic forms marked. */
export function moduleReferences(path, source) {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const references = [];
  const add = (node, argument, typeOnly) => {
    const literal =
      argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument));
    references.push({
      specifier: literal ? argument.text : null,
      typeOnly,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    });
  };
  const isRequire = (expression) =>
    (ts.isIdentifier(expression) && expression.text === "require") ||
    (ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "require" &&
      expression.name.text === "resolve");
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
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return references;
}

const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const typesPackage = (name) =>
  `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
const subpathImport = (manifest, specifier) =>
  Object.keys(manifest.imports ?? {}).some((key) =>
    key.includes("*") ? specifier.startsWith(key.slice(0, key.indexOf("*"))) : key === specifier,
  );

/**
 * Checks that the directories the release check treats as a public package's
 * source import only packages their own manifest declares. The release check's
 * dependency trees follow declared dependencies only; an import that resolves
 * through the root manifest or through hoisting would escape them.
 *
 * In a public package's own directory any declared dependency is accepted,
 * because its whole importer is part of the tree. In a workspace package the
 * CLI bundles, runtime imports must be production or optional dependencies, or
 * peers (which the tree follows into the matching devDependencies).
 */
export function declaredImportViolations({
  cwd = process.cwd(),
  allowlist = dynamicImportAllowlist,
} = {}) {
  const state = worktreeState(cwd);
  const workspaces = workspacePackages(state);
  const manifests = new Map(
    [...workspaces.values()].map(({ directory, manifest }) => [directory, manifest]),
  );
  const bundled = new Map();
  for (const item of publicPackages(state))
    for (const directory of sourceDirectories(item, state))
      bundled.set(directory, bundled.get(directory) || directory !== item.directory);
  const allowed = new Map(allowlist.map(({ path, reason }) => [path, reason]));
  const violations = [];
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
    const excluded = (relative) => tooling.some((pattern) => pattern.test(relative));
    for (const path of [...state.entries.keys()].sort()) {
      if (!path.startsWith(`${directory}/`) || !codeFile.test(path) || testsOnly(path)) continue;
      const relative = path.slice(directory.length + 1);
      if (excluded(relative)) continue;
      for (const { specifier, typeOnly, line } of moduleReferences(
        path,
        state.read(path).toString(),
      )) {
        const where = `${path}:${line}`;
        if (specifier === null) {
          if (!allowed.has(path))
            violations.push(`${where}: non-literal dynamic import or require`);
          continue;
        }
        if (specifier.startsWith(".")) {
          // Source reached through a relative path outside the package would be
          // bundled without this check, or the path rule, seeing it.
          const target = posix.relative(directory, posix.join(posix.dirname(path), specifier));
          if (target === ".." || target.startsWith("../"))
            violations.push(
              `${where}: "${specifier}" leaves ${directory}; import workspace packages by name`,
            );
          else if (excluded(target))
            violations.push(`${where}: "${specifier}" imports excluded tooling`);
          continue;
        }
        if (specifier.startsWith("/")) violations.push(`${where}: absolute import "${specifier}"`);
        else if (specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
        else if (specifier.startsWith("#")) {
          if (!subpathImport(manifest, specifier))
            violations.push(`${where}: "${specifier}" has no imports entry in its manifest`);
        } else {
          const name = packageName(specifier);
          // A type-only reference may be served by the package's DefinitelyTyped types.
          const declaredIn = (set) => set.has(name) || (typeOnly && set.has(typesPackage(name)));
          if (name === manifest.name || declaredIn(production)) continue;
          // Types are erased from the CLI bundle, so bundled workspace sources may
          // take them from devDependencies.
          if (declaredIn(development) && (!linked || typeOnly)) continue;
          violations.push(
            declaredIn(development)
              ? `${where}: "${name}" is only a devDependency of ${directory}, which a public package bundles; declare it in dependencies, optionalDependencies, or as a peer with that devDependency providing it`
              : peers.has(name)
                ? `${where}: "${name}" is only a peerDependency of ${directory} and nothing installs it there; add the providing version to devDependencies`
                : `${where}: "${name}" is not declared in ${directory}/package.json`,
          );
        }
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
