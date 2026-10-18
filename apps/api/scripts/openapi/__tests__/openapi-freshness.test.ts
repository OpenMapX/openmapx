import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCUMENT_PATH, generateDocument } from "../document.js";

describe("apps/api/openapi.json", () => {
  it("documents both complete runtime metadata operations with resolvable references", async () => {
    const document = JSON.parse(await generateDocument());
    for (const [path, operationId] of [
      ["/api/capabilities", "getApiCapabilities"],
      ["/api/integrations", "getApiIntegrations"],
    ]) {
      const operation = document.paths[path].get;
      expect(operation.operationId).toBe(operationId);
      expect(operation.tags).toContain("runtime-metadata");
      expect(operation["x-openmapx-auth"]).toBe("public");
      expect(operation.responses["200"].content["application/json"].schema).toBeDefined();
      expect(operation.responses["200"].content["application/json"].schema.$ref).toBe(
        `#/components/schemas/${path === "/api/capabilities" ? "CapabilitiesResponse" : "IntegrationsResponse"}`,
      );
    }
    expect(document.paths["/api/integrations"].get.responses["304"].content).toBeUndefined();
    const unresolved: string[] = [];
    function inspect(value: unknown): void {
      if (!value || typeof value !== "object") return;
      const ref = (value as { $ref?: unknown }).$ref;
      if (typeof ref === "string" && ref.startsWith("#/")) {
        let target: unknown = document;
        for (const part of ref.slice(2).split("/")) {
          const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
          target =
            target && typeof target === "object"
              ? (target as Record<string, unknown>)[key]
              : undefined;
        }
        if (target === undefined) unresolved.push(ref);
      }
      for (const child of Object.values(value)) inspect(child);
    }
    inspect(document);
    expect(unresolved).toEqual([]);
  }, 30_000);
  it("matches the current API surface", async () => {
    const generated = await generateDocument();
    const committed = readFileSync(DOCUMENT_PATH, "utf8");

    expect(
      committed === generated,
      "The committed OpenAPI document no longer matches the routes the API registers. " +
        "Run `pnpm openapi:generate` and commit the result alongside your route change.",
    ).toBe(true);
  }, 30_000);

  it("classifies the auth requirement of every operation", async () => {
    const document = JSON.parse(await generateDocument()) as {
      paths: Record<string, Record<string, { "x-openmapx-auth"?: string }>>;
    };

    const unclassified: string[] = [];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (operation["x-openmapx-auth"] === "unspecified") {
          unclassified.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(
      unclassified,
      "Every route must declare how it authenticates. Call declareRouteAuth(fastify, level) " +
        "in the route plugin, or set config: { auth: level } on the route.",
    ).toEqual([]);
  });

  it("does not document an admin route as reachable without credentials", async () => {
    const document = JSON.parse(await generateDocument()) as {
      paths: Record<string, Record<string, { "x-openmapx-auth"?: string }>>;
    };

    const open = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/api/admin"))
      .flatMap(([path, operations]) =>
        Object.entries(operations)
          .filter(([, operation]) => operation["x-openmapx-auth"] !== "admin")
          .map(([method]) => `${method.toUpperCase()} ${path}`),
      );

    expect(open).toEqual([]);
  });
});
