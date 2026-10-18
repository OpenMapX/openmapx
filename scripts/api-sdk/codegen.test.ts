import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateArtifacts, writeOrCheckArtifacts } from "./codegen.mjs";
import { validatedResponseTypes } from "./validated-response-types.mjs";

const directories: string[] = [];
async function directory() {
  const result = await mkdtemp(join(tmpdir(), "api-sdk-test-"));
  directories.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SDK artifact gate", () => {
  it("rejects unsupported response shapes instead of inventing validator bindings", () => {
    expect(() =>
      validatedResponseTypes({
        operationId: "unsupported",
        response: {
          definition: { success: "string" },
          types: { success: [{ value: "string", isRef: false, key: "200" }], errors: [] },
        },
      }),
    ).toThrow(/named JSON success schema/);
  });
  it("detects stale, missing and extra files without changing them", async () => {
    const outputDirectory = await directory();
    const files = [{ filename: "sdk.generated.ts", content: "generated\n" }];
    await writeOrCheckArtifacts(files, { outputDirectory });
    await expect(
      writeOrCheckArtifacts(files, { outputDirectory, check: true }),
    ).resolves.toBeUndefined();
    await writeFile(join(outputDirectory, "sdk.generated.ts"), "stale\n");
    await writeFile(join(outputDirectory, "old.generated.ts"), "old\n");
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      /stale|extra/,
    );
    expect(await readFile(join(outputDirectory, "sdk.generated.ts"), "utf8")).toBe("stale\n");
    expect(await readFile(join(outputDirectory, "old.generated.ts"), "utf8")).toBe("old\n");
    await writeFile(join(outputDirectory, "sdk.generated.ts"), "generated\n");
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      "old.generated.ts (extra)",
    );
    await rm(join(outputDirectory, "old.generated.ts"));
    await rm(join(outputDirectory, "sdk.generated.ts"));
    await expect(writeOrCheckArtifacts(files, { outputDirectory, check: true })).rejects.toThrow(
      /missing/,
    );
  });

  it("generates deterministically and keeps only the approved family", async () => {
    const first = await generateArtifacts();
    expect(await generateArtifacts()).toEqual(first);
    const sdk = first.find(
      (file: { filename: string }) => file.filename === "runtime-metadata.generated.ts",
    )?.content;
    expect(sdk).toContain("getApiCapabilities");
    expect(sdk).toContain("getApiIntegrations");
    expect(sdk).toContain("data: IntegrationsResponseOutput");
    expect(sdk).toContain("status: 304");
    expect(sdk).toContain("schema: IntegrationsResponse");
    expect(sdk).not.toContain("getApiAdmin");
    const content = first.map((file: { content: string }) => file.content).join("\n");
    expect(content).toContain("zod.lazy");
    expect(content).not.toContain("zod.unknown()");
  }, 30_000);
});
