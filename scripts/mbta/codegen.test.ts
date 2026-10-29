import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateArtifacts, writeOrCheckArtifacts } from "./codegen.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe("MBTA offline generation and freshness", () => {
  it("generates deterministic six-operation validated host requests", async () => {
    const first = await generateArtifacts();
    const second = await generateArtifacts();
    expect(first).toEqual(second);
    await writeOrCheckArtifacts(first, { check: true });
    const artifact = first.find((file) => file.filename === "client.ts");
    if (!artifact) throw new Error("Missing generated client");
    const client = artifact.content;
    expect(client.match(/return mbtaRequest</g)).toHaveLength(6);
    expect(client.match(/schema: /g)).toHaveLength(6);
    expect(client).not.toMatch(/await fetch\(/);
  }, 90000);
  it("checks stale, missing and extra files without mutating them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mbta-artifact-"));
    directories.push(directory);
    const files = [{ filename: "client.ts", content: "expected\n" }];
    await writeOrCheckArtifacts(files, { outputDirectory: directory });
    await writeFile(join(directory, "client.ts"), "stale\n");
    await expect(
      writeOrCheckArtifacts(files, { outputDirectory: directory, check: true }),
    ).rejects.toThrow(/stale/);
    expect(await readFile(join(directory, "client.ts"), "utf8")).toBe("stale\n");
    await rm(join(directory, "client.ts"));
    await expect(
      writeOrCheckArtifacts(files, { outputDirectory: directory, check: true }),
    ).rejects.toThrow(/missing/);
    await writeFile(join(directory, "client.ts"), "expected\n");
    await writeFile(join(directory, "extra.ts"), "old\n");
    await expect(
      writeOrCheckArtifacts(files, { outputDirectory: directory, check: true }),
    ).rejects.toThrow(/extra/);
    expect(await readFile(join(directory, "extra.ts"), "utf8")).toBe("old\n");
  });
  it("rejects changed pinned bytes and operation bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mbta-schema-"));
    directories.push(directory);
    const path = join(directory, "schema.json");
    const source = await readFile("integrations/transit-mbta/schema/swagger.json", "utf8");
    await writeFile(path, `${source}\n`);
    await expect(generateArtifacts({ inputPath: path })).rejects.toThrow(/SHA-256/);
    const document = JSON.parse(source);
    document.paths["/stops"].get.operationId = "changed";
    await expect(generateArtifacts({ document })).rejects.toThrow(/contract/);
  });
});
