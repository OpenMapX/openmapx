import { join, resolve } from "node:path";
import { buildDocument, serializeDocument } from "./build-document.js";
import { collectCoreRoutes } from "./collect-core-routes.js";
import { collectIntegrationRoutes } from "./collect-integration-routes.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
export const DOCUMENT_PATH = join(REPO_ROOT, "apps", "api", "openapi.json");

/**
 * Builds the document from the current tree. No server listens and nothing is
 * written, so this is safe to call from a test.
 */
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

/** Number of documented operations, for the CLI's summary line. */
export function operationCount(document: string): number {
  const parsed = JSON.parse(document) as { paths: Record<string, Record<string, unknown>> };
  return Object.values(parsed.paths).reduce((total, item) => total + Object.keys(item).length, 0);
}
