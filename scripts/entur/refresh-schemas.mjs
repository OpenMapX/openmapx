import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildClientSchema,
  getIntrospectionQuery,
  lexicographicSortSchema,
  printSchema,
} from "graphql";
import { formatSource } from "../codegen/format-source.mjs";

const directory = new URL("../../packages/mobility-formats/entur/schema/", import.meta.url);
const sources = [
  ["journey-planner", "https://api.entur.io/journey-planner/v3/graphql"],
  ["vehicles", "https://api.entur.io/realtime/v2/vehicles/graphql"],
];

// Refresh is an explicit maintainer action. Generation and CI use these local
// snapshots and never depend on live introspection or provider availability.
const snapshots = await Promise.all(
  sources.map(async ([name, endpoint]) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": "openmapx-codegen" },
      body: JSON.stringify({ query: getIntrospectionQuery() }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`${name}: introspection HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length || !payload.data) {
      throw new Error(`${name}: introspection failed: ${JSON.stringify(payload.errors)}`);
    }
    const schema = printSchema(lexicographicSortSchema(buildClientSchema(payload.data)));
    const content = formatSource(
      fileURLToPath(new URL(`${name}.graphql`, directory)),
      `# Generated schema snapshot from ${endpoint}\n# Data made available by Entur AS under NLOD-2.0. See ../README.md.\n\n${schema}\n`,
    );
    return { name, endpoint, content, sha256: createHash("sha256").update(content).digest("hex") };
  }),
);

await mkdir(directory, { recursive: true });
for (const { name, content } of snapshots) {
  await writeFile(new URL(`${name}.graphql`, directory), content);
  console.log(`Updated ${name} schema in ${fileURLToPath(directory)}`);
}
await writeFile(
  new URL("provenance.json", directory),
  `${JSON.stringify(
    {
      retrievedAt: new Date().toISOString(),
      source: "Entur public GraphQL introspection",
      license: "NLOD-2.0",
      schemas: snapshots.map(({ name, endpoint, sha256 }) => ({ name, endpoint, sha256 })),
    },
    null,
    2,
  )}\n`,
);
