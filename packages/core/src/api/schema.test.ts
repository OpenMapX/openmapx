import { describe, expect, it } from "vitest";
import z from "zod/v4";
import { convertJsonSchemaTuplesToOpenApi31, routeJsonSchema } from "./schema";

describe("shared route JSON Schema emission", () => {
  it("makes recursive definitions globally resolvable without losing key restrictions", () => {
    const definitions: Record<string, unknown>[] = [];
    const schema = routeJsonSchema(
      z.strictObject({
        metadata: z.json(),
        values: z.record(z.string().regex(/^id:/), z.number()),
      }),
      {
        identity: "ContractFixture",
        io: "output",
        registerDefinition: (value) => {
          definitions.push(value);
        },
      },
    );
    const ids = new Set(definitions.map((value) => `${value.$id}#`));
    const references: string[] = [];
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (typeof node.$ref === "string") references.push(node.$ref);
      for (const child of Object.values(node)) visit(child);
    }
    visit([schema, ...definitions]);
    expect(references.length).toBeGreaterThan(0);
    expect(references.every((reference) => ids.has(reference))).toBe(true);
    expect(schema).toMatchObject({
      properties: { values: { propertyNames: { pattern: "^id:" } } },
    });
  });

  it("exports bounded coordinate tuples using the OpenAPI 3.1 dialect", () => {
    const document = {
      components: {
        schemas: {
          Bounds: {
            type: "array",
            items: [{ type: "number" }, { type: "number" }, { type: "number" }, { type: "number" }],
            minItems: 4,
            maxItems: 4,
            additionalItems: false,
          },
        },
      },
    };
    convertJsonSchemaTuplesToOpenApi31(document);
    expect(document.components.schemas.Bounds).toEqual({
      type: "array",
      prefixItems: Array.from({ length: 4 }, () => ({ type: "number" })),
      items: false,
      minItems: 4,
      maxItems: 4,
    });
  });
});
