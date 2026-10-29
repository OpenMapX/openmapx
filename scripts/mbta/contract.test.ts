import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildContract, OPERATIONS } from "./contract.mjs";

const original = JSON.parse(readFileSync("integrations/transit-mbta/schema/swagger.json", "utf8"));
describe("MBTA reviewed schema corrections", () => {
  it("limits generation to exactly the six active HTTP operations", () => {
    expect(Object.keys(buildContract(original).paths).sort()).toEqual(
      Object.keys(OPERATIONS).sort(),
    );
  });
  it("preserves typed included route, schedule, trip and stop resources on list documents", () => {
    const schema = buildContract(original);
    expect(schema.components.schemas.Predictions.properties.included.items.oneOf).toEqual([
      { $ref: "#/components/schemas/RouteResource" },
      { $ref: "#/components/schemas/ScheduleResource" },
      { $ref: "#/components/schemas/TripResource" },
      { $ref: "#/components/schemas/StopResource" },
    ]);
  });
  it("validates resource identity and permits empty to-one relationships", () => {
    const resource = buildContract(original).components.schemas.PredictionResource;
    expect(resource.required).toContain("id");
    expect(resource.properties.type.enum).toEqual(["prediction"]);
    expect(resource.properties.relationships.properties.schedule.properties.data.type).toContain(
      "null",
    );
  });
  it("keeps only used attributes and makes first/last schedule times nullable", () => {
    const schema = buildContract(original);
    expect(
      schema.components.schemas.PredictionResource.properties.attributes.properties,
    ).not.toHaveProperty("status");
    expect(
      schema.components.schemas.ScheduleResource.properties.attributes.properties.departure_time
        .type,
    ).toContain("null");
  });
  it("rejects changed operation bindings and missing projected attributes", () => {
    const operation = structuredClone(original);
    operation.paths["/stops"].get.responses[200].schema.$ref = "#/definitions/Alerts";
    expect(() => buildContract(operation)).toThrow(/contract/);
    const attribute = structuredClone(original);
    delete attribute.definitions.StopResource.properties.attributes.properties.latitude;
    expect(() => buildContract(attribute)).toThrow(/contract/);
  });
  it("keeps upstream documentation out of executable schema descriptions", () => {
    const schema = buildContract(original);
    function check(value: unknown): void {
      if (!value || typeof value !== "object") return;
      // Resource properties named description are data and must remain in the contract.
      expect(value).not.toHaveProperty("description", expect.any(String));
      for (const child of Object.values(value)) check(child);
    }
    check(schema.components.schemas);
    expect(schema.components.schemas.AlertResource.properties.attributes.properties).toHaveProperty(
      "description",
    );
  });
  it("does not mutate the pinned source document", () => {
    const before = JSON.stringify(original);
    buildContract(original);
    expect(JSON.stringify(original)).toBe(before);
  });
});
