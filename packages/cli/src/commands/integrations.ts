import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildIntegration,
  buildIntegrationBackend,
  listIntegrations as coreListIntegrations,
  type IntegrationSummary,
  installIntegration,
  packageIntegration,
  removeIntegration,
  validateIntegrationDirectory,
} from "@openmapx/integration-framework/installer";
import type { Command } from "commander";
import kleur from "kleur";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";

export function listIntegrations(opts: { rootDir?: string; includeBuiltIn?: boolean } = {}) {
  const paths = repoPaths(opts.rootDir);
  return coreListIntegrations({ rootDir: paths.root, includeBuiltIn: opts.includeBuiltIn });
}

// Re-export from core so test files (and any other in-monorepo caller) can
// pull the same symbol from a single module path.
export { installIntegration, removeIntegration };
export const validateIntegration = validateIntegrationDirectory;

export function formatIntegrationsTable(rows: IntegrationSummary[]): string {
  if (rows.length === 0) return "(no community integrations installed)";
  return table(
    [
      { key: "id", header: "ID" },
      { key: "version", header: "Version" },
      { key: "quality", header: "Quality" },
      { key: "name", header: "Name" },
      { key: "bundle", header: "Bundle" },
    ],
    rows.map((r) => ({
      id: r.id,
      version: r.version,
      quality: r.quality,
      name: r.name,
      bundle: r.hasBundle ? "built" : "—",
    })),
  );
}

const VALID_ID = /^[a-z][a-z0-9-]*$/;
const TEMPLATE_DIR = "_template";

export interface ScaffoldOptions {
  id: string;
  domain?: string;
  integrationsDir: string;
}

export function scaffoldIntegration({ id, domain, integrationsDir }: ScaffoldOptions): string {
  if (!VALID_ID.test(id)) {
    throw new Error(
      `Invalid integration id "${id}". Must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`,
    );
  }

  const destDir = join(integrationsDir, id);
  if (existsSync(destDir)) {
    throw new Error(
      `Integration "${id}" already exists at ${destDir}. Choose a different id or remove the existing directory.`,
    );
  }

  const templateDir = join(integrationsDir, TEMPLATE_DIR);
  if (!existsSync(templateDir)) {
    throw new Error(
      `Template directory not found at ${templateDir}. Make sure the repo is complete.`,
    );
  }

  const domainToken = domain ?? "__DOMAIN__";

  mkdirSync(destDir, { recursive: true });
  cpSync(templateDir, destDir, { recursive: true });

  substituteTokensInDir(destDir, id, domainToken);

  const pkgTemplate = join(destDir, "package.json.template");
  if (existsSync(pkgTemplate)) {
    renameSync(pkgTemplate, join(destDir, "package.json"));
  }

  return destDir;
}

function substituteTokensInDir(dir: string, id: string, domain: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteTokensInDir(fullPath, id, domain);
    } else if (entry.isFile()) {
      const content = readFileSync(fullPath, "utf-8");
      const replaced = content.replaceAll("__ID__", id).replaceAll("__DOMAIN__", domain);
      if (replaced !== content) {
        writeFileSync(fullPath, replaced, "utf-8");
      }
    }
  }
}

function streamLog(line: string, stream: "stdout" | "stderr"): void {
  if (stream === "stderr") log.warn(line);
  else log.dim(line);
}

export function registerIntegrationsCommands(program: Command): void {
  const integrations = program
    .command("integrations")
    .description("Manage community integrations under custom_integrations/");

  integrations
    .command("scaffold <id>")
    .description(
      "Scaffold a new built-in integration under integrations/<id>/ from the _template directory",
    )
    .option("--domain <domain>", "Primary domain for the integration (e.g. knowledge, weather)")
    .action((id: string, options: { domain?: string }) => {
      const paths = repoPaths();
      try {
        const destDir = scaffoldIntegration({
          id,
          domain: options.domain,
          integrationsDir: paths.integrationsDir,
        });
        log.ok(`Scaffolded integration ${kleur.bold(id)} at ${destDir}`);
        log.info("");
        log.info("Next steps:");
        log.dim(
          `  1. Fill in manifest.json — add dataSources[], update healthCheck.url, set author.`,
        );
        log.dim(`  2. Implement setup(ctx) in index.ts.`);
        log.dim(`  3. Run pnpm install to pick up the new workspace package.`);
        log.dim(`  4. Start the API (pnpm dev) — the host loads it automatically.`);
        log.dim(`  5. Read the full walkthrough: docs/docs/developer/writing-an-integration.md`);
      } catch (err) {
        log.err(`scaffold failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  integrations
    .command("list")
    .description("List installed community integrations")
    .option("--include-built-in", "Also list built-in integrations under integrations/")
    .action((options: { includeBuiltIn?: boolean }) => {
      const rows = listIntegrations({ includeBuiltIn: options.includeBuiltIn });
      console.log(formatIntegrationsTable(rows));
    });

  integrations
    .command("install <source>")
    .description("Install a community integration from source or a prebuilt .tar.gz artifact")
    .option("--ref <ref>", "Branch or tag to clone (Git sources only)")
    .option("--artifact", "Treat source as a prebuilt OpenMapX integration artifact")
    .option("--sha256 <hash>", "Expected sha256 for an artifact install")
    .option("--no-build", "Skip building frontend/backend bundle files during source install")
    .action(
      async (
        source: string,
        options: {
          ref?: string;
          build?: boolean;
          artifact?: boolean;
          sha256?: string;
        },
      ) => {
        const paths = repoPaths();
        try {
          const result = await installIntegration({
            rootDir: paths.root,
            source,
            sourceKind: options.artifact ? "artifact" : "source",
            ref: options.ref,
            artifactSha256: options.sha256,
            buildFrontend: !options.artifact && options.build !== false,
            buildBackend: !options.artifact && options.build !== false,
            onLog: streamLog,
          });
          log.ok(
            `${result.replaced ? "Replaced" : "Installed"} integration ${kleur.bold(result.id)}`,
          );
          log.dim(result.directory);
          if (result.build) {
            if (result.build.skipped) {
              log.dim(`Frontend bundle skipped: ${result.build.reason ?? "not needed"}`);
            } else {
              log.ok(`Frontend bundle written → ${result.build.bundlePath}`);
            }
          }
          if (result.backendBuild) {
            if (result.backendBuild.skipped) {
              log.dim(`Backend bundle skipped: ${result.backendBuild.reason ?? "not needed"}`);
            } else {
              log.ok(`Backend bundle written → ${result.backendBuild.bundlePath}`);
            }
          }
          log.info("");
          log.info("Next steps:");
          log.dim("  • Restart app-api so the integration host picks up the new manifest:");
          log.dim(`      pnpm openmapx services restart app-api`);
        } catch (err) {
          log.err(`install failed: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  integrations
    .command("remove <id>")
    .description("Remove a community integration")
    .action((id: string) => {
      const paths = repoPaths();
      try {
        const result = removeIntegration({ rootDir: paths.root, id });
        log.ok(`Removed ${kleur.bold(id)}`);
        log.dim(result.directory);
        log.dim("(restart app-api to deactivate)");
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });

  integrations
    .command("validate [id]")
    .description("Validate one community integration manifest, or all if omitted")
    .action((id: string | undefined) => {
      const paths = repoPaths();
      const targets: string[] = [];
      if (id) {
        targets.push(join(paths.customIntegrationsDir, id));
      } else if (existsSync(paths.customIntegrationsDir)) {
        for (const entry of readdirSync(paths.customIntegrationsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) targets.push(join(paths.customIntegrationsDir, entry.name));
        }
      }

      if (targets.length === 0) {
        log.info("(no community integrations to validate)");
        return;
      }

      let allOk = true;
      for (const dir of targets) {
        const result = validateIntegrationDirectory(dir);
        if (result.valid) {
          log.ok(`${result.id}: manifest valid`);
        } else {
          allOk = false;
          log.err(`${result.id}: invalid`);
          for (const e of result.errors) log.dim(`    - ${e}`);
        }
      }
      if (!allOk) process.exit(1);
    });

  integrations
    .command("build <id>")
    .description("Build frontend and backend bundles for a community integration")
    .action(async (id: string) => {
      const paths = repoPaths();
      try {
        const frontend = await buildIntegration({ rootDir: paths.root, id, onLog: streamLog });
        const backend = await buildIntegrationBackend({
          rootDir: paths.root,
          id,
          onLog: streamLog,
        });
        if (frontend.skipped) {
          log.info(`${id}: frontend ${frontend.reason ?? "skipped"}`);
        } else {
          log.ok(`${id}: frontend bundle written → ${frontend.bundlePath}`);
        }
        if (backend.skipped) {
          log.info(`${id}: backend ${backend.reason ?? "skipped"}`);
        } else {
          log.ok(`${id}: backend bundle written → ${backend.bundlePath}`);
        }
      } catch (err) {
        log.err(`build failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  integrations
    .command("package <source>")
    .description("Create a prebuilt .tar.gz artifact for admin/production installs")
    .requiredOption("--out <file>", "Artifact output path")
    .option(
      "--no-build",
      "Require existing dist/frontend/index.js and dist/backend/index.mjs instead of building",
    )
    .action(async (source: string, options: { out: string; build?: boolean }) => {
      const paths = repoPaths();
      try {
        const result = await packageIntegration({
          rootDir: paths.root,
          source,
          outFile: options.out,
          buildFrontend: options.build !== false,
          buildBackend: options.build !== false,
          onLog: streamLog,
        });
        log.ok(`Packaged integration ${kleur.bold(result.id)}`);
        log.dim(result.artifactPath);
      } catch (err) {
        log.err(`package failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
