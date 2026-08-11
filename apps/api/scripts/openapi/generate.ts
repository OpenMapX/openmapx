import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildDocument, serializeDocument } from "./build-document.js";
import { collectCoreRoutes } from "./collect-core-routes.js";
import { collectIntegrationRoutes } from "./collect-integration-routes.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
export const DOCUMENT_PATH = join(REPO_ROOT, "apps", "api", "openapi.json");

/** Builds the document from the current tree. No server is started and nothing is written. */
export async function generateDocument(): Promise<string> {
  const core = await collectCoreRoutes();
  return serializeDocument(
    buildDocument({
      corePaths: core.paths,
      coreAuth: core.auth,
      integrationRoutes: collectIntegrationRoutes(REPO_ROOT),
    }),
  );
}

function operationCount(document: string): number {
  const parsed = JSON.parse(document) as { paths: Record<string, Record<string, unknown>> };
  return Object.values(parsed.paths).reduce((total, item) => total + Object.keys(item).length, 0);
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const generated = await generateDocument();

  if (!check) {
    writeFileSync(DOCUMENT_PATH, generated);
    console.log(
      `✓ Wrote apps/api/openapi.json — ${operationCount(generated)} operations across the core API and integration routes.`,
    );
    return;
  }

  let committed: string;
  try {
    committed = readFileSync(DOCUMENT_PATH, "utf8");
  } catch {
    console.error(
      "✗ apps/api/openapi.json is missing. Run `pnpm openapi:generate` and commit the result.",
    );
    process.exitCode = 1;
    return;
  }

  if (committed !== generated) {
    console.error(
      "✗ apps/api/openapi.json is out of date — the API surface changed.\n" +
        "  Run `pnpm openapi:generate` and commit the result alongside your route change.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`✓ OpenAPI document up to date — ${operationCount(generated)} operations.`);
}

await main();
// Route modules install timers and keep lazy clients around, which would hold
// the event loop open after the document is written.
process.exit(process.exitCode ?? 0);
