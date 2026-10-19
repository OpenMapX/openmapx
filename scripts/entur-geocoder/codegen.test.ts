import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateArtifacts, writeOrCheckArtifacts } from "./codegen.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("Entur Geocoder generated artifact gate", () => {
  it("detects stale, missing and extra artifacts without rewriting check targets", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "entur-geocoder-test-"));
    directories.push(outputDirectory);
    const files = [{ filename: "client.ts", content: "generated\n" }];
    await writeOrCheckArtifacts(files, { outputDirectory });
    await writeOrCheckArtifacts(files, { outputDirectory, check: true });
    await writeFile(join(outputDirectory, "client.ts"), "stale\n");
    await writeFile(join(outputDirectory, "obsolete.ts"), "old\n");
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      "client.ts (stale)",
    );
    expect(await readFile(join(outputDirectory, "client.ts"), "utf8")).toBe("stale\n");
    await writeFile(join(outputDirectory, "client.ts"), "generated\n");
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      "obsolete.ts (extra)",
    );
    expect(await readFile(join(outputDirectory, "obsolete.ts"), "utf8")).toBe("old\n");
    await rm(join(outputDirectory, "client.ts"));
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      "client.ts (missing)",
    );
  });
  it("generates deterministic complete output sets from the offline snapshot", async () => {
    const first = await generateArtifacts();
    const second = await generateArtifacts();
    expect(second).toEqual(first);
    await writeOrCheckArtifacts(first, { check: true });
  });
  it("rejects a changed success binding rather than generating an unvalidated operation", async () => {
    const document = JSON.parse(
      await readFile("packages/entur-client/schema/geocoder.openapi.json", "utf8"),
    );
    document.paths["/v3/autocomplete"].get.responses["200"].content["application/json"].schema = {
      type: "string",
    };
    await expect(generateArtifacts({ document })).rejects.toThrow(/contract/);
  });
  it("rejects changed snapshot bytes even when the parsed contract is identical", async () => {
    const directory = await mkdtemp(join(tmpdir(), "entur-geocoder-input-"));
    directories.push(directory);
    const inputPath = join(directory, "schema.json");
    await writeFile(
      inputPath,
      `${await readFile("packages/entur-client/schema/geocoder.openapi.json", "utf8")}\n`,
    );
    await expect(generateArtifacts({ inputPath })).rejects.toThrow(/SHA-256/);
  });
});
