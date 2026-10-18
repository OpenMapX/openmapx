import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { generateArtifacts, writeOrCheckArtifacts } from "./codegen.mjs";

const directories: string[] = [];

async function fixture(document: string, schema = "type Query { hello(name: String!): String }") {
  const directory = await mkdtemp(join(tmpdir(), "entur-codegen-"));
  directories.push(directory);
  const schemaPath = join(directory, "schema.graphql");
  const documents = join(directory, "operations.graphql");
  const filename = join(directory, "output.generated.ts");
  await writeFile(schemaPath, schema);
  await writeFile(documents, document);
  return { schema: schemaPath, documents, filename };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Entur operation generation", () => {
  it("rejects operations selecting a field absent from the pinned schema", async () => {
    const target = await fixture("query Hello { missing }");
    await expect(generateArtifacts([target])).rejects.toThrow(/Cannot query field.*missing/s);
  });

  it("rejects a variable with a type incompatible with its argument", async () => {
    const target = await fixture(
      "query Hello($name: Int!) { hello(name: $name) }",
      "type Query { hello(name: String!): String, count: Int }",
    );
    await expect(generateArtifacts([target])).rejects.toThrow(/Int!.*String!/s);
  });

  it("fails when a schema introduces an unreviewed custom scalar", async () => {
    const target = await fixture(
      "query Hello { hello }",
      "scalar Unreviewed\ntype Query { hello: Unreviewed }",
    );
    await expect(generateArtifacts([target])).rejects.toThrow(/Unreviewed/);
  });

  it("validates both production operation families and generates deterministic artifacts", async () => {
    const first = await generateArtifacts();
    const second = await generateArtifacts();
    expect(first).toHaveLength(2);
    expect(first.every((file: { content: string }) => file.content.length > 0)).toBe(true);
    expect(second).toEqual(first);
    const generated = new Map(
      first.map((file: { filename: string; content: string }) => [file.filename, file.content]),
    );
    const options = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile;
    host.readFile = (filename) => generated.get(filename) ?? readFile(filename);
    const program = ts.createProgram([...generated.keys()], options, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
  });

  it("writes generated output and detects stale content without changing it", async () => {
    const target = await fixture("query Hello($name: String!) { hello(name: $name) }");
    const files = await generateArtifacts([target]);
    await writeOrCheckArtifacts(files);
    await expect(writeOrCheckArtifacts(files, { check: true })).resolves.toBeUndefined();
    await writeFile(target.filename, "// stale\n");
    await expect(writeOrCheckArtifacts(files, { check: true })).rejects.toThrow(
      /stale.*entur:generate/s,
    );
    expect(await readFile(target.filename, "utf8")).toBe("// stale\n");
  });

  it("reports missing output without creating it in check mode", async () => {
    const target = await fixture("query Hello($name: String!) { hello(name: $name) }");
    const files = await generateArtifacts([target]);
    await expect(writeOrCheckArtifacts(files, { check: true })).rejects.toThrow(
      /missing.*entur:generate/s,
    );
    await expect(readFile(target.filename)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
