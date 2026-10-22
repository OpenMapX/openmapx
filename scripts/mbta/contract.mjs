import { upgrade } from "@scalar/openapi-parser";
// A small projection of the upstream specification, not a parallel model hierarchy.
export const OPERATIONS = {
  "/stops": ["ApiWeb.StopController.index", "Stops"],
  "/stops/{id}": ["ApiWeb.StopController.show", "Stop"],
  "/predictions": ["ApiWeb.PredictionController.index", "Predictions"],
  "/vehicles": ["ApiWeb.VehicleController.index", "Vehicles"],
  "/alerts": ["ApiWeb.AlertController.index", "Alerts"],
  "/facilities": ["ApiWeb.FacilityController.index", "Facilities"],
};

const resources = {
  StopResource: [
    "stop",
    ["name", "latitude", "longitude", "vehicle_type", "platform_code"],
    ["parent_station"],
  ],
  PredictionResource: [
    "prediction",
    ["arrival_time", "departure_time", "trip_headsign", "schedule_relationship"],
    ["route", "schedule", "trip", "stop"],
  ],
  VehicleResource: [
    "vehicle",
    ["latitude", "longitude", "bearing", "speed", "label", "current_stop_sequence", "updated_at"],
    ["route", "trip", "stop"],
  ],
  AlertResource: [
    "alert",
    ["severity", "effect", "header", "description", "informed_entity", "active_period"],
    [],
  ],
  FacilityResource: ["facility", ["type", "long_name", "short_name", "properties"], []],
  RouteResource: ["route", ["type", "short_name", "long_name", "color"], []],
  ScheduleResource: ["schedule", ["arrival_time", "departure_time"], []],
  TripResource: ["trip", ["headsign"], []],
};
function requireValue(value) {
  if (value === undefined || value === null) throw new Error("Unsupported MBTA source contract");
  return value;
}
function select(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, requireValue(object?.[key])]));
}

export function buildContract(document) {
  const schema = structuredClone(document);
  if (
    schema.swagger !== "2.0" ||
    schema.securityDefinitions?.api_key_in_header?.name !== "x-api-key"
  )
    throw new Error("Unsupported MBTA source contract");
  schema.paths = Object.fromEntries(
    Object.entries(OPERATIONS).map(([path, [id, result]]) => {
      const operation = requireValue(schema.paths?.[path]?.get);
      if (
        operation.operationId !== id ||
        operation.responses?.[200]?.schema?.$ref !== `#/definitions/${result}`
      )
        throw new Error("Unsupported MBTA operation contract");
      return [path, { get: operation }];
    }),
  );
  for (const [name, [type, attributes, relations]] of Object.entries(resources)) {
    const resource = requireValue(schema.definitions?.[name]);
    const properties = requireValue(resource.properties);
    resource.properties = select(properties, ["type", "id", "attributes"]);
    resource.required = ["type", "id"];
    properties.type.enum = [type];
    properties.id.minLength = 1;
    properties.attributes.properties = select(properties.attributes.properties, attributes);
    if (relations.length) {
      resource.properties.relationships = requireValue(properties.relationships);
      properties.relationships.properties = select(properties.relationships.properties, relations);
      // JSON:API empty to-one linkage is null, including an unscheduled prediction.
      for (const relation of Object.values(properties.relationships.properties)) {
        relation.properties = select(relation.properties, ["data"]);
        relation.properties.data["x-nullable"] = true;
      }
    }
  }
  // The views emit nil for optional GTFS fields and first/last schedule times.
  for (const [name, fields] of Object.entries({
    ScheduleResource: ["arrival_time", "departure_time"],
    VehicleResource: ["bearing", "speed", "label", "current_stop_sequence"],
    TripResource: ["headsign"],
    FacilityResource: ["long_name", "short_name"],
  }))
    for (const field of fields)
      schema.definitions[name].properties.attributes.properties[field]["x-nullable"] = true;
  for (const name of ["ScheduleResource", "PredictionResource"])
    for (const field of ["arrival_time", "departure_time"])
      schema.definitions[name].properties.attributes.properties[field].format = "date-time";
  for (const [, result] of Object.values(OPERATIONS)) {
    const links = schema.definitions[result].properties?.links?.properties;
    if (links) for (const value of Object.values(links)) value["x-nullable"] = true;
  }
  const converted = upgrade(schema).specification;
  if (!converted?.openapi?.startsWith("3.")) throw new Error("Unsupported MBTA upgraded contract");
  converted.components.schemas.Predictions.properties.included = {
    type: "array",
    items: {
      oneOf: ["RouteResource", "ScheduleResource", "TripResource", "StopResource"].map((name) => ({
        $ref: `#/components/schemas/${name}`,
      })),
    },
  };
  // Include only reachable definitions. New endpoints/models are deliberate scope changes.
  const reachable = new Set();
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref?.startsWith("#/components/schemas/")) {
      const name = value.$ref.slice("#/components/schemas/".length);
      if (!reachable.has(name)) {
        reachable.add(name);
        visit(requireValue(converted.components.schemas[name]));
      }
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(converted.paths);
  converted.components.schemas = Object.fromEntries(
    [...reachable].sort().map((name) => [name, converted.components.schemas[name]]),
  );
  // Documentation remains in the immutable source snapshot. Runtime descriptions
  // embed documentation URLs in executable validators and confuse data-flow analysis.
  function omitDescriptions(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.description === "string") delete value.description;
    for (const child of Object.values(value)) omitDescriptions(child);
  }
  omitDescriptions(converted.components.schemas);
  return converted;
}
