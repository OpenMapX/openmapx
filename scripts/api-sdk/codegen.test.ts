import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { build } = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "esbuild",
);

import { generateArtifacts, writeOrCheckArtifacts } from "./codegen.mjs";
import { selectTaggedDocument } from "./config.mjs";
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
  it("isolates family schemas while preserving recursive refs and security definitions", () => {
    const document = {
      paths: {
        "/metadata": {
          get: {
            operationId: "metadata",
            tags: ["runtime-metadata"],
            responses: {
              200: {
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Metadata" } },
                },
              },
            },
          },
        },
        "/admin": {
          post: {
            operationId: "admin",
            tags: ["data-manager-admin"],
            responses: {
              200: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/Admin" } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Metadata: { type: "string" },
          Admin: { type: "object", properties: { next: { $ref: "#/components/schemas/Admin" } } },
        },
        securitySchemes: { session: { type: "apiKey", in: "cookie", name: "session" } },
      },
    };
    const metadata = selectTaggedDocument(document, "runtime-metadata");
    expect(Object.keys(metadata.paths)).toEqual(["/metadata"]);
    expect(Object.keys(metadata.components.schemas)).toEqual(["Metadata"]);
    expect(metadata.components.securitySchemes).toEqual(document.components.securitySchemes);
    expect(
      Object.keys(selectTaggedDocument(document, "data-manager-admin").components.schemas),
    ).toEqual(["Admin"]);
    expect(document.components.schemas).toHaveProperty("Admin");
  });
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

  it("generates deterministic adopted families while preserving runtime metadata", async () => {
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
    const admin = first.find(
      (file: { filename: string }) => file.filename === "admin/data-manager-admin.generated.ts",
    )?.content;
    expect(admin).toContain("postApiDataManagerTransitSync");
    expect(admin).toContain("status: 202");
    expect(admin).toContain("status: 409");
    expect(admin).toContain("status: 422");
    expect(admin).toContain("encodeURIComponent");
    const bindings = first.find(
      (file: { filename: string }) => file.filename === "admin/operation-bindings.generated.ts",
    )?.content;
    expect(bindings).toContain('bindAdminOperation("getApiDataManagerTransitState")');
    expect(bindings).not.toContain("/api/");
    const metadata = first.filter(
      (file: { filename: string }) => !file.filename.startsWith("admin/"),
    );
    expect(metadata).toHaveLength(6);
    for (const file of metadata)
      expect(file.content).toBe(
        await readFile(
          new URL(`../../packages/core/src/api/generated/${file.filename}`, import.meta.url),
          "utf8",
        ),
      );
    expect(
      first
        .filter((file: { filename: string }) => file.filename.startsWith("admin/"))
        .map((file: { content: string }) => file.content)
        .join("\n"),
    ).not.toContain('from "zod');
    const content = first.map((file: { content: string }) => file.content).join("\n");
    expect(content).toContain("zod.lazy");
    expect(content).not.toContain("zod.unknown()");
  }, 90_000);
});

describe("activity generation", () => {
  it("generates all five operations and an honest EventSource target using the generated URL", async () => {
    const input = JSON.parse(
      await readFile(new URL("../../apps/api/openapi.json", import.meta.url), "utf8"),
    );
    const ids = [
      ["listAdminActivityJobs", "get", "/api/admin/jobs"],
      ["getAdminActivityJob", "get", "/api/admin/jobs/{id}"],
      ["cancelAdminActivityJob", "post", "/api/admin/jobs/{id}/cancel"],
      ["getAdminActivityJobStreamMetrics", "get", "/api/admin/jobs/stream-metrics"],
      ["streamAdminActivityJobEvents", "get", "/api/admin/jobs/{id}/events"],
    ];
    for (const [id, method, path] of ids) {
      const stream = id === "streamAdminActivityJobEvents";
      input.paths[path] ??= {};
      input.paths[path][method] = {
        operationId: id,
        tags: ["activity-admin"],
        parameters: [
          ...(path.includes("{id}")
            ? [{ in: "path", name: "id", required: true, schema: { type: "string" } }]
            : []),
          ...(id === "listAdminActivityJobs"
            ? [
                {
                  in: "query",
                  name: "limit",
                  schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
                },
                {
                  in: "query",
                  name: "offset",
                  schema: {
                    type: "integer",
                    minimum: 0,
                    maximum: Number.MAX_SAFE_INTEGER,
                    default: 0,
                  },
                },
              ]
            : []),
          ...(stream
            ? [
                {
                  in: "header",
                  name: "last-event-id",
                  schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                },
                { in: "query", name: "source", schema: { type: "string", enum: ["application"] } },
                {
                  in: "query",
                  name: "cursor",
                  schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                },
              ]
            : []),
        ],
        responses: {
          200: {
            description: "ok",
            content: {
              [stream ? "text/event-stream" : "application/json"]: { schema: { type: "string" } },
            },
          },
        },
      };
    }
    vi.stubGlobal("fetch", () => {
      throw new Error("Unexpected network");
    });
    try {
      const files = await generateArtifacts({ document: input });
      // Every previously committed family/model stays byte-stable when adding activity.
      const previous = await generateArtifacts();
      for (const file of previous.filter(
        (f: { filename: string }) => f.filename !== "admin/operation-bindings.generated.ts",
      ))
        expect(files.find((f: { filename: string }) => f.filename === file.filename)?.content).toBe(
          file.content,
        );
      const activity = files.find(
        (f: { filename: string }) => f.filename === "admin/activity-admin.generated.ts",
      );
      expect(activity).toBeDefined();
      for (const [id] of ids) expect(activity.content).toContain(`export const ${id} =`);
      expect(activity.content).toContain("Promise<AdminEventStreamTarget>");
      expect(activity.content).not.toContain("Promise<string>");
      const bindings = files.find(
        (f: { filename: string }) => f.filename === "admin/operation-bindings.generated.ts",
      ).content;
      const result = await build({
        stdin: {
          contents: activity.content,
          loader: "ts",
          resolveDir: new URL("../../packages/core/src/api/generated/admin", import.meta.url)
            .pathname,
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        plugins: [
          {
            name: "generated-bindings",
            setup(builder) {
              builder.onResolve({ filter: /operation-bindings.generated/ }, () => ({
                path: "bindings",
                namespace: "fixture",
              }));
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                contents: bindings,
                loader: "ts",
                resolveDir: new URL("../../packages/core/src/api/generated/admin", import.meta.url)
                  .pathname,
              }));
            },
          },
        ],
      });
      const sdk = await import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
      );
      expect(
        Object.keys(sdk)
          .filter((name) => !name.startsWith("get") || ids.some(([id]) => name === id))
          .sort(),
      ).toEqual(ids.map(([id]) => id).sort());
      const { createApiClient } = await import("../../packages/core/src/api/client");
      const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
      expect(
        sdk.getStreamAdminActivityJobEventsUrl("a/b?#", { source: "application", cursor: 2 }),
      ).toBe("/api/admin/jobs/a%2Fb%3F%23/events?source=application&cursor=2");
      await expect(
        sdk.streamAdminActivityJobEvents("a/b?#", { source: "application", cursor: 2 }, undefined, {
          client,
        }),
      ).resolves.toEqual({
        url: "https://app.example/api/admin/jobs/a%2Fb%3F%23/events?source=application&cursor=2",
        withCredentials: true,
      });
      vi.stubGlobal("fetch", async (url: string) => {
        if (url !== "https://app.example/api/admin/jobs") throw new Error("Unexpected network");
        return Response.json({ jobs: [], total: 0 });
      });
      await expect(sdk.listAdminActivityJobs(undefined, { client })).resolves.toMatchObject({
        status: 200,
        data: { jobs: [], total: 0 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  }, 90_000);
});
