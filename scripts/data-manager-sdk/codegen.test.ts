import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateArtifacts, writeOrCheckArtifacts } from "./codegen.mjs";
import { operationIds } from "./config.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const document = {
  openapi: "3.0.3",
  info: { title: "Data-manager generator regression", version: "1" },
  paths: {
    "/status": {
      get: {
        operationId: "getStatus",
        responses: {
          200: {
            description: "ready",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                  required: ["ok"],
                },
              },
            },
          },
          503: {
            description: "unready",
            content: {
              "application/json": {
                schema: { type: "object", properties: { error: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    "/archive/{id}": {
      get: {
        operationId: "getOfflinePackageArchive",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          206: {
            description: "partial",
            content: { "application/zip": { schema: { type: "string", format: "binary" } } },
          },
        },
      },
      head: {
        operationId: "headOfflinePackageArchive",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "headers" }, 416: { description: "range" } },
      },
    },
  },
};
describe("data-manager SDK generation", () => {
  it("rejects missing and duplicate operation identity", () => {
    expect(() => operationIds({ paths: { "/a": { get: {} } } })).toThrow();
    expect(() =>
      operationIds({
        paths: { "/a": { get: { operationId: "same" }, post: { operationId: "same" } } },
      }),
    ).toThrow(/Duplicate/);
  });
  it("fails closed when Orval reports an invalid document without throwing", async () => {
    await expect(
      generateArtifacts({
        document: {
          openapi: "3.0.3",
          info: { title: "Invalid", version: "1" },
          paths: {
            "/status": {
              get: {
                operationId: "getStatus",
                responses: {
                  200: {
                    description: "invalid",
                    content: {
                      "application/json": { schema: { $ref: "#/components/schemas/DoesNotExist" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/did not generate/);
  });
  it("generates truthful HEAD and GET416 types from the actual collected OpenAPI3.1 document", async () => {
    const actual = JSON.parse(
      await readFile(new URL("../../services/data-manager/openapi.json", import.meta.url), "utf8"),
    );
    const archive = "/offline/packages/{packageId}/archive";
    const glyph = "/offline/packages/glyphs/{version}/{fontstack}/{range}.pbf";
    expect(actual.openapi).toBe("3.1.0");
    const fixture = {
      ...actual,
      paths: { [archive]: actual.paths[archive], [glyph]: actual.paths[glyph] },
    };
    const files = await generateArtifacts({ document: fixture });
    const sdk =
      files.find((file: { filename: string }) => file.filename === "data-manager.generated.ts")
        ?.content ?? "";
    for (const [path, operationId] of [
      [archive, "headOfflinePackageArchive"],
      [glyph, "headOfflineGlyph"],
    ]) {
      for (const status of Object.keys(actual.paths[path].head.responses)) {
        expect(actual.paths[path].head.responses[status]).not.toHaveProperty("content");
        expect(sdk).toContain(`export type ${operationId}Response${status} = {\n  data: void;`);
      }
    }
    expect(sdk).toContain("export type getOfflinePackageArchiveResponse416 = {\n  data: void;");
    expect(sdk).not.toContain("data: unknown");
  }, 30000);
  it("generates exact stable files with bound identity, honest raw/HEAD and status unions", async () => {
    const first = await generateArtifacts({ document });
    expect(await generateArtifacts({ document })).toEqual(first);
    const sdk = first.find(
      (file: { filename: string }) => file.filename === "data-manager.generated.ts",
    )?.content;
    expect(sdk).toContain("data: globalThis.Response");
    expect(sdk).toContain("status: 503");
    expect(sdk).toContain("data: void");
    expect(sdk).toContain("encodeURIComponent");
    expect(sdk).not.toContain("Blob");
    const bindings = first.find(
      (file: { filename: string }) => file.filename === "operation-bindings.generated.ts",
    )?.content;
    expect(bindings).toContain('bindDataManagerOperation("getStatus")');
    expect(bindings).not.toContain("/status");
    const outputDirectory = await mkdtemp(join(tmpdir(), "dm-sdk-test-"));
    directories.push(outputDirectory);
    await writeOrCheckArtifacts(first, { outputDirectory });
    await expect(
      writeOrCheckArtifacts(first, { outputDirectory, check: true }),
    ).resolves.toBeUndefined();
    await writeFile(join(outputDirectory, "extra.ts"), "extra");
    await expect(writeOrCheckArtifacts(first, { outputDirectory, check: true })).rejects.toThrow(
      /extra/,
    );
    expect(await readFile(join(outputDirectory, "extra.ts"), "utf8")).toBe("extra");
    await rm(join(outputDirectory, "extra.ts"));
    await writeFile(join(outputDirectory, first[0].filename), "stale");
    await expect(writeOrCheckArtifacts(first, { outputDirectory, check: true })).rejects.toThrow(
      /stale/,
    );
    await rm(join(outputDirectory, first[0].filename));
    await expect(writeOrCheckArtifacts(first, { outputDirectory, check: true })).rejects.toThrow(
      /missing/,
    );
  }, 30000);
});
