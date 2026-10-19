import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import swagger from "@fastify/swagger";
import { convertJsonSchemaTuplesToOpenApi31 } from "@openmapx/core/api-schema";
import { dataManagerOperations } from "@openmapx/core/data-manager-contracts";
import Fastify from "fastify";
import { registerApi } from "../../src/api.js";
import { registerAuth } from "../../src/auth.js";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";
import type { OfflinePackageGenerator } from "../../src/offline-packages/generator.js";

export const DOCUMENT_PATH = new URL("../../openapi.json", import.meta.url);
const methods = new Set(["get", "head", "post", "delete", "put", "patch", "options"]);

/** Collect actual registrations without listening, launching jobs, or opening a database. */
export async function generateDocument(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openmapx-dm-openapi-"));
  const app = Fastify({ logger: false, exposeHeadRoutes: false });
  const registrations = new Map<string, { method: string; path: string; auth: unknown }>();
  try {
    await app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: { title: "OpenMapX data-manager", version: "1.0.0" },
        components: {
          securitySchemes: {
            serviceBearer: { type: "http", scheme: "bearer" },
            serviceToken: { type: "apiKey", in: "header", name: "x-data-manager-token" },
          },
        },
      },
      exposeHeadRoutes: true,
      refResolver: {
        buildLocalReference: (json, _base, _fragment, index) =>
          typeof json.$id === "string" ? json.$id : `DataManagerSchema${index}`,
      },
      transformObject: (context) => {
        const openapiObject = "openapiObject" in context ? context.openapiObject : undefined;
        if (!openapiObject) throw new Error("Expected OpenAPI document");
        for (const path of Object.values(openapiObject.paths ?? {})) {
          for (const [method, value] of Object.entries(path ?? {})) {
            if (!methods.has(method) || !value || typeof value !== "object") continue;
            const operation = value as Record<string, unknown>;
            // Swagger adds '-head' even to explicit HEAD registrations.
            operation.operationId = operation["x-openmapx-contract-id"];
          }
        }
        convertJsonSchemaTuplesToOpenApi31(openapiObject);
        return openapiObject;
      },
    });
    app.addHook("onRoute", (route) => {
      const schema = route.schema as Record<string, unknown> | undefined;
      const id = schema?.["x-openmapx-contract-id"];
      if (typeof id !== "string" || registrations.has(id))
        throw new Error(
          `Uncontracted or duplicate data-manager route: ${route.method} ${route.url}`,
        );
      registrations.set(id, {
        method: String(route.method),
        path: route.url,
        auth: schema?.["x-openmapx-auth"],
      });
    });
    registerAuth(app, "openapi-collection-only");
    // Registration only stores this collaborator; invoking a generator while
    // collecting the surface is a bug and fails immediately.
    const offlinePackages = new Proxy(
      {},
      {
        get: () => {
          throw new Error("OpenAPI collection invoked offline package generation");
        },
      },
    ) as OfflinePackageGenerator;
    registerApi(app, {
      dataDir: directory,
      repoRoot: directory,
      offlinePackages,
      operationsPolicy: resolveOperationsProfile({ allowEmptyRegional: true }),
    });
    await app.ready();
    for (const [id, operation] of Object.entries(dataManagerOperations)) {
      const route = registrations.get(id);
      if (
        !route ||
        route.method !== operation.method ||
        route.path !== operation.path ||
        route.auth !== operation.auth
      )
        throw new Error(`Data-manager route contract differs: ${id}`);
    }
    if (registrations.size !== Object.keys(dataManagerOperations).length)
      throw new Error("Data-manager route inventory differs");
    const document = app.swagger();
    let count = 0;
    for (const path of Object.values(document.paths ?? {})) {
      for (const [method, value] of Object.entries(path ?? {})) {
        if (!methods.has(method)) continue;
        const operation = value as { operationId?: string };
        if (!operation.operationId || !registrations.has(operation.operationId))
          throw new Error("OpenAPI lost a registered data-manager operation");
        count++;
      }
    }
    if (count !== registrations.size) throw new Error("OpenAPI omitted data-manager routes");
    return `${JSON.stringify(document, null, 2)}\n`;
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
