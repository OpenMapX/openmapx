#!/usr/bin/env node

// Type-checks the TypeScript the required `check-types` run does not cover and
// reports how many errors each project has. The errors are known and are being
// cleared, so the exit status stays 0 however many there are. It is non-zero
// only when a project cannot be checked at all (a missing or invalid
// configuration, no input files, an unresolvable `types` entry), so that a
// broken configuration is never reported as "0 errors".

import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const projects = [
  { name: "repo-tools", config: "scripts/tsconfig.json" },
  { name: "integration-tests", config: "apps/web/tsconfig.integration-tests.json" },
  { name: "mobility-core", config: "packages/mobility-core/tsconfig.json" },
];

export class ProjectConfigurationError extends Error {}

function messageOf(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

/** Type-checks one project. Throws `ProjectConfigurationError` when it cannot be checked. */
export function checkProject({ name, config }, root = repositoryRoot) {
  const configPath = resolve(root, config);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new ProjectConfigurationError(`${name}: ${messageOf(read.error)}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new ProjectConfigurationError(
      `${name}: ${parsed.errors.map((error) => `TS${error.code} ${messageOf(error)}`).join("; ")}`,
    );
  }
  if (parsed.fileNames.length === 0) {
    throw new ProjectConfigurationError(`${name}: ${config} matches no files`);
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
    projectReferences: parsed.projectReferences,
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

  // An error with no source file comes from the configuration (an unresolvable
  // `types` entry, an invalid option combination), not from the code.
  const global = diagnostics.filter((diagnostic) => !diagnostic.file);
  if (global.length > 0) {
    throw new ProjectConfigurationError(
      `${name}: ${global.map((diagnostic) => `TS${diagnostic.code} ${messageOf(diagnostic)}`).join("; ")}`,
    );
  }

  return {
    name,
    config,
    files: parsed.fileNames.length,
    errors: diagnostics.length,
    filesWithErrors: new Set(diagnostics.map((diagnostic) => diagnostic.file.fileName)).size,
  };
}

export function formatReport(results) {
  const width = Math.max(...results.map((result) => result.name.length));
  const lines = results.map(
    (result) =>
      `${result.name.padEnd(width)}  ${String(result.errors).padStart(5)} errors in ${String(result.filesWithErrors).padStart(4)} files  (${result.files} files checked)  tsc -p ${result.config}`,
  );
  const total = results.reduce((sum, result) => sum + result.errors, 0);
  const checked = results.reduce((sum, result) => sum + result.files, 0);
  lines.push(
    `${"total".padEnd(width)}  ${String(total).padStart(5)} errors  (${checked} files checked)`,
  );
  return lines.join("\n");
}

export function formatSummary(results) {
  const total = results.reduce((sum, result) => sum + result.errors, 0);
  const checked = results.reduce((sum, result) => sum + result.files, 0);
  return [
    "### Type errors outside the required `check-types` run",
    "",
    "| Project | Errors | Files with errors | Files checked | Configuration |",
    "| --- | ---: | ---: | ---: | --- |",
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.errors} | ${result.filesWithErrors} | ${result.files} | \`${result.config}\` |`,
    ),
    `| **Total** | **${total}** | | **${checked}** | |`,
    "",
  ].join("\n");
}

/**
 * Returns the exit status: 0 whenever every project could be checked.
 *
 * @param {{
 *   list?: { name: string; config: string }[];
 *   root?: string;
 *   summaryPath?: string;
 *   log?: { log: (line: string) => unknown; error: (line: string) => unknown };
 * }} [options]
 */
export function run({ list = projects, root = repositoryRoot, summaryPath, log = console } = {}) {
  const results = [];
  for (const project of list) {
    try {
      results.push(checkProject(project, root));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`✗ cannot type-check ${message}`);
      return 1;
    }
  }
  log.log(formatReport(results));
  if (summaryPath) {
    appendFileSync(summaryPath, `${formatSummary(results)}\n`);
  }
  return 0;
}

function main(argv) {
  const flag = argv.indexOf("--summary");
  const summaryPath = flag === -1 ? undefined : argv[flag + 1];
  if (flag !== -1 && !summaryPath) {
    console.error("✗ --summary needs a file path");
    return 1;
  }
  return run({ summaryPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
