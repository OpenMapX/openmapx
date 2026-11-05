import { readFile, writeFile } from "node:fs/promises";
import { dataManagerOperations } from "@openmapx/core/data-manager-contracts";
import { DOCUMENT_PATH, generateDocument } from "./document.js";

try {
  const document = await generateDocument();
  if (process.argv.includes("--check")) {
    if ((await readFile(DOCUMENT_PATH, "utf8")) !== document)
      throw new Error(
        "Data-manager OpenAPI differs. Run pnpm data-manager:openapi:generate and commit the result.",
      );
    console.log(
      `Data-manager OpenAPI is current (${Object.keys(dataManagerOperations).length} operations).`,
    );
  } else {
    await writeFile(DOCUMENT_PATH, document);
    console.log(
      `Wrote services/data-manager/openapi.json (${Object.keys(dataManagerOperations).length} operations).`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
// Imported route modules own lazy clients and housekeeping timers. The
// collector never starts the service, and the command has no remaining work.
process.exit(process.exitCode ?? 0);
