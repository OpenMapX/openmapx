import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const directory = resolve(repositoryRoot, "packages/mobility-formats/entur");
const targets = ["journey-planner", "vehicles"].map((family) => ({
  schema: resolve(directory, "schema", `${family}.graphql`),
  documents: resolve(directory, "operations", `${family}.graphql`),
  filename: resolve(directory, `${family}.generated.ts`),
}));

// Wire representations described in the pinned SDL. Keep new scalars explicit:
// strictScalars rejects additions instead of silently generating `any`/`unknown`.
const scalars = {
  Coordinates: "number[][]",
  Cost: "string",
  Date: "string",
  DateTime: "string",
  DoubleFunction: "string",
  Duration: "string",
  LocalTime: "string",
  Long: "number",
  Time: "string",
};

export function createCodegenConfig(selectedTargets = targets) {
  return {
    silent: true,
    generates: Object.fromEntries(
      selectedTargets.map(({ schema, documents, filename }) => [
        filename,
        {
          schema,
          documents,
          // Operations v6 emits its own referenced input/enum/utility types.
          // Adding the base typescript plugin duplicates those declarations.
          plugins: ["typescript-operations", "typed-document-node"],
          config: {
            documentMode: "string",
            enumType: "string-literal",
            skipTypename: true,
            avoidOptionals: { field: true },
            useTypeImports: true,
            strictScalars: true,
            scalars,
          },
        },
      ]),
    ),
  };
}

export default createCodegenConfig();
