import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createAuthoringSchemas } from "../dist/schemas.js";

const dir = new URL("../schemas/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(createAuthoringSchemas())) {
  const path = new URL(`${name}.json`, dir);
  const text = `${JSON.stringify(schema, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (!isDeepStrictEqual(JSON.parse(readFileSync(path, "utf8")), schema))
      throw new Error(`Stale ${name} authoring schema; rebuild extension-contracts.`);
  } else writeFileSync(path, text);
}
