import { readFileSync, writeFileSync } from "node:fs";
import { DOCUMENT_PATH, generateDocument, operationCount } from "./document.js";

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
