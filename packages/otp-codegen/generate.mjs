import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codegen } from "@graphql-codegen/core";
import * as sdk from "@graphql-codegen/typescript-generic-sdk";
import * as operations from "@graphql-codegen/typescript-operations";
import { buildASTSchema, parse, print, validate, validateSchema } from "graphql";
import * as validation from "graphql-codegen-typescript-validation-schema";
import ts from "typescript";
import { formatSource } from "../../scripts/codegen/format-source.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scalarTypes = {
  CoordinateValue: "number",
  Cost: "number",
  Duration: "string",
  GeoJson: "unknown",
  Grams: "number",
  LocalDate: "string",
  Locale: "string",
  Long: "number",
  OffsetDateTime: "string",
  Polyline: "string",
  Ratio: "number",
  Reluctance: "number",
  Speed: "number",
};
const scalarSchemas = Object.fromEntries(
  Object.entries(scalarTypes).map(([name, type]) => [
    name,
    name === "OffsetDateTime"
      ? "z.iso.datetime({ offset: true })"
      : name === "Long"
        ? "z.number().int().safe()"
        : type === "number"
          ? "z.number().finite()"
          : type === "string"
            ? "z.string()"
            : "z.unknown()",
  ]),
);
/** Select complete generated result declarations and their generated enum dependencies.
 * No validator expressions are synthesized or changed. The plugin also emits every
 * input schema; those are not runtime operation-result contracts and are omitted.
 */
export function selectOperationValidators(source, names) {
  const file = ts.createSourceFile("validators.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
    }
  }
  const selected = new Set();
  function include(name) {
    if (selected.has(name)) return;
    const statement = declarations.get(name);
    if (!statement) throw new Error(`Missing generated result dependency: ${name}`);
    selected.add(name);
    function dependencies(node) {
      if (ts.isIdentifier(node) && node.text.endsWith("Schema") && node.text !== name)
        include(node.text);
      ts.forEachChild(node, dependencies);
    }
    dependencies(statement);
  }
  for (const name of names) include(`${name}Schema`);
  return (
    `import * as z from "zod";\nimport type { ${names.join(", ")} } from "./sdk";\n` +
    [...new Set([...selected].map((name) => declarations.get(name)))]
      .sort((a, b) => a.pos - b.pos)
      .map((statement) => statement.getText(file))
      .join("\n")
  );
}
export async function generateArtifacts({ source, document } = {}) {
  const schema = parse(
    source ??
      (await readFile(resolve(root, "packages/otp-client/schema/gtfs-2.10.graphql"), "utf8")),
  );
  const parsed = buildASTSchema(schema);
  const errors = validateSchema(parsed);
  const documents = [
    {
      document: parse(
        document ??
          (await readFile(resolve(root, "packages/otp-client/operations/gtfs.graphql"), "utf8")),
      ),
    },
  ];
  errors.push(...validate(parsed, documents[0].document));
  if (errors.length) throw new Error(errors.map((error) => error.message).join("\n"));
  const config = {
    documentMode: "documentNode",
    skipTypename: true,
    useTypeImports: true,
    enumType: "string-literal",
    enumsAsTypes: true,
    avoidOptionals: { field: true },
    strictScalars: true,
    scalars: scalarTypes,
    disableDescriptions: true,
    schema: "zodv4",
    scalarSchemas,
    withOperationType: true,
    validationSchemaExportType: "const",
    zodOptionalType: "nullable",
  };
  const directory = resolve(root, "packages/otp-client/src/generated");
  const operationNames = documents[0].document.definitions
    .filter((def) => def.kind === "OperationDefinition")
    .map((def) => def.name.value + "Query");
  const filename = resolve(directory, "sdk.ts");
  const sdkSource = await codegen({
    filename,
    schema,
    documents,
    config,
    plugins: [{ operations: {} }, { sdk: {} }],
    pluginMap: { operations, sdk },
  });
  const validatorSource = await codegen({
    filename: resolve(directory, "validators.ts"),
    schema,
    documents,
    config: { ...config, importFrom: "./sdk" },
    plugins: [{ validation: {} }],
    pluginMap: { validation },
  });
  const bindings = documents[0].document.definitions
    .filter((def) => def.kind === "OperationDefinition")
    .map((operation) => {
      const name = operation.name.value;
      return `[${name}Document, { query: ${JSON.stringify(print({ kind: "Document", definitions: [operation, ...documents[0].document.definitions.filter((def) => def.kind === "FragmentDefinition")] }))}, schema: ${name}QuerySchema }]`;
    });
  const outputs = [
    { filename, content: sdkSource },
    {
      filename: resolve(directory, "validators.ts"),
      content: selectOperationValidators(validatorSource, operationNames),
    },
    {
      filename: resolve(directory, "bindings.ts"),
      content: `import { ${operationNames.map((name) => name.replace(/Query$/, "Document")).join(", ")} } from "./sdk";\nimport { ${operationNames.map((name) => name + "Schema").join(", ")} } from "./validators";\nimport type { ZodType } from "zod";\nexport const operationBindings = new Map<unknown, {query: string; schema: ZodType}>([${bindings.join(",\n")}]);\n`,
    },
  ];
  return outputs.map((output) => ({
    ...output,
    content: formatSource(
      output.filename,
      "// biome-ignore-all lint: Generated by pnpm otp:generate; edit schema/operations instead.\n" +
        output.content,
    ),
  }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--check"))
      throw new Error("Usage: generate.mjs [--check]");
    const files = await generateArtifacts();
    for (const file of files) {
      if (process.argv.includes("--check")) {
        if ((await readFile(file.filename, "utf8").catch(() => "")) !== file.content)
          throw new Error("OTP artifacts stale: run pnpm otp:generate");
      } else await writeFile(file.filename, file.content);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
