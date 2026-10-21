import { readFileSync } from "node:fs";
import { extensionAdminOperations } from "@openmapx/core/api-contracts";
import { expect, it } from "vitest";
import { extensionOperationInventory } from "../../../src/routes/__tests__/helpers/extension-admin-fixtures";
import { generateDocument } from "../document";

it("collects all eleven actual extension producers without changing the baseline path inventory", async () => {
  const document = JSON.parse(await generateDocument());
  const committed = JSON.parse(
    readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8"),
  );
  expect(Object.keys(document.paths).sort()).toEqual(Object.keys(committed.paths).sort());
  expect(Object.keys(document.paths)).toHaveLength(364);
  expect(
    Object.values(document.paths).reduce(
      (count: number, item) => count + Object.keys(item as object).length,
      0,
    ),
  ).toBe(390);
  const tagged = Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods as object)
      .filter(([, operation]) => operation.tags?.includes("extension-admin"))
      .map(([method, operation]) => [method.toUpperCase(), path, operation.operationId]),
  );
  expect(tagged.sort()).toEqual(
    extensionOperationInventory
      .map(([method, path, id]) => [
        method,
        `/api/admin/extensions${path.replace(":id", "{id}")}`,
        id,
      ])
      .sort(),
  );
  for (const [method, suffix, id, success] of extensionOperationInventory) {
    const operation =
      document.paths[`/api/admin/extensions${suffix.replace(":id", "{id}")}`][method.toLowerCase()];
    expect(operation["x-openmapx-auth"]).toBe("admin");
    expect(Object.keys(operation.responses).map(Number).sort()).toEqual(
      [
        success,
        400,
        401,
        403,
        413,
        415,
        429,
        500,
        ...([
          "getAdminExtensionCatalogEntry",
          "previewAdminExtensionInstall",
          "installAdminExtension",
        ].includes(id)
          ? [404]
          : []),
      ].sort(),
    );
    expect(operation.responses[429].headers).toHaveProperty("retry-after");
    for (const response of Object.values(operation.responses) as { content: object }[])
      expect(Object.keys(response.content)).toEqual(["application/json"]);
    expect(Object.keys(operation.responses).sort()).toEqual(
      Object.keys(extensionAdminOperations[id].responses).sort(),
    );
  }
  for (const suffix of ["update/{id}", "{id}", "refresh-catalog"]) {
    const method = suffix === "{id}" ? "delete" : "post";
    expect(document.paths[`/api/admin/extensions/${suffix}`][method].requestBody).toMatchObject({
      required: false,
      content: { "application/json": expect.any(Object) },
    });
  }
  for (const suffix of ["install", "install-preview", "sources"])
    expect(document.paths[`/api/admin/extensions/${suffix}`].post.requestBody.required).toBe(true);
}, 30000);

it("retains canonical schemas exactly in the real document, including recursive JSON and optional bodies", async () => {
  const { routeJsonSchema, convertJsonSchemaTuplesToOpenApi31 } = await import(
    "@openmapx/core/api-schema"
  );
  const document = JSON.parse(await generateDocument());
  // Only normalize reference spelling/dialect, never properties, constraints or required fields.
  function normalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "$id")
        .map(([key, child]) => [
          key === "const" ? "enum" : key,
          key === "const"
            ? [child]
            : key === "$ref" && typeof child === "string" && child.endsWith("#")
              ? `#/components/schemas/${child.slice(0, -1)}`
              : normalize(child),
        ]),
    );
  }
  function emit(schema: import("zod/v4").ZodType, identity: string, io: "input" | "output") {
    const definitions: Record<string, unknown> = {};
    const output = routeJsonSchema(schema, {
      identity: `Admin_${identity}`,
      io,
      registerDefinition: (definition) => {
        definitions[definition.$id] = definition;
      },
    });
    convertJsonSchemaTuplesToOpenApi31(output);
    convertJsonSchemaTuplesToOpenApi31(definitions);
    for (const [id, definition] of Object.entries(definitions))
      expect(document.components.schemas[id]).toEqual(normalize(definition));
    return normalize(output);
  }
  for (const [id, entry] of Object.entries(extensionAdminOperations)) {
    const operation =
      document.paths[entry.path.replace(/:([^/]+)/g, "{$1}")][entry.method.toLowerCase()];
    const contract: import("@openmapx/core/api-contracts").AdminOperation = entry;
    for (const [status, response] of Object.entries(contract.responses)) {
      if (!("schema" in response)) throw Error("Expected JSON schema");
      expect(operation.responses[status].content["application/json"].schema).toEqual(
        emit(response.schema, `${id}_${status}`, "output"),
      );
    }
    if (contract.request?.body)
      expect(operation.requestBody.content["application/json"].schema).toEqual(
        emit(contract.request.body, `${id}_body`, "input"),
      );
  }
}, 30000);
