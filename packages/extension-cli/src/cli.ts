import { join } from "node:path";
import { Command } from "commander";
import { type BundleOptions, runBundle } from "./commands/bundle.js";
import { runPackage } from "./commands/package.js";
import { scaffoldIntegration, scaffoldService } from "./commands/scaffold.js";
import { runValidate } from "./commands/validate.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name("openmapx-ext")
  .description("OpenMapX extension authoring CLI — scaffold, package, and validate integrations")
  .version("0.1.0");

const scaffold = program
  .command("scaffold")
  .description("Scaffold a new integration or service from a template");

scaffold
  .command("integration <id>")
  .description("Scaffold a new integration directory from the built-in template")
  .option("--domain <domain>", "Primary domain (e.g. knowledge, weather)")
  .option("--out <dir>", "Output directory (defaults to current working directory)", process.cwd())
  .action((id: string, options: { domain?: string; out: string }) => {
    try {
      const destDir = scaffoldIntegration({ id, domain: options.domain, outDir: options.out });
      console.log(`Scaffolded integration "${id}" at ${destDir}`);
      console.log("");
      console.log("Next steps:");
      console.log("  1. Fill in manifest.json — add dataSources[], update healthCheck.url.");
      console.log("  2. Implement setup(ctx) in index.ts.");
      console.log(`  3. Run: openmapx-ext validate ${join(options.out, id)}`);
      console.log(`  4. Run: openmapx-ext package ${join(options.out, id)} --out artifact.tar.gz`);
    } catch (err) {
      console.error(`scaffold integration failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

scaffold
  .command("service <id>")
  .description("Scaffold a new service.json from the built-in template")
  .option("--out <dir>", "Output directory (defaults to current working directory)", process.cwd())
  .action((id: string, options: { out: string }) => {
    try {
      const destPath = scaffoldService({ id, outDir: options.out });
      console.log(`Scaffolded service "${id}" at ${destPath}`);
      console.log("");
      console.log("Next steps:");
      console.log("  1. Update the image, tag, expose ports, and environment in service.json.");
      console.log("  2. Declare what the service provides in the `provides` array.");
      console.log(
        "  3. If your service owns a Postgres schema, set `ownsSchema` to your schema name.",
      );
    } catch (err) {
      console.error(`scaffold service failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("package <source>")
  .description("Build and package an integration into a distributable .tar.gz artifact")
  .requiredOption("--out <file>", "Artifact output path (e.g. my-integration.tar.gz)")
  .option("--no-build", "Skip building — require pre-built dist/ bundles")
  .action(async (source: string, options: { out: string; build?: boolean }) => {
    try {
      await runPackage({ source, out: options.out, build: options.build });
    } catch (err) {
      console.error(`package failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("validate <source>")
  .description("Validate an integration directory against the manifest schema")
  .action(async (source: string) => {
    await runValidate(source);
  });

program
  .command("bundle")
  .description("Emit an extension.json bundle (N services + N integrations) for the store")
  .requiredOption("--id <id>", "Extension id (lowercase, hyphenated)")
  .requiredOption("--name <name>", "Display name")
  .requiredOption("--version <version>", "Bundle version (SemVer)")
  .option("--platform <version>", "Minimum platform version")
  .option("--description <text>", "Description")
  .option("--license <spdx>", "SPDX license id")
  .option("--homepage <url>", "Homepage URL")
  .option("--service <repo,ref,serviceId>", "Service component (repeatable)", collect, [])
  .option(
    "--integration <artifactUrl,sha256,id>",
    "Integration component (repeatable)",
    collect,
    [],
  )
  .option("--out <file>", "Output path", "extension.json")
  .action((options: BundleOptions & { out: string }) => {
    try {
      const out = runBundle(options);
      console.log(`Wrote ${out}`);
    } catch (err) {
      console.error(`bundle failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
