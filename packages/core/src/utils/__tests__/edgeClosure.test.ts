import { describe, expect, it } from "vitest";
import { isEdgeClosure, isRoutingRelevantBinding, PASSENGER_CAR_CLASSES } from "../edgeClosure";

describe("isEdgeClosure", () => {
  it("road_closure closes unless roadState says open", () => {
    expect(isEdgeClosure({ type: "road_closure" })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", roadState: "closed" })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", roadState: "open" })).toBe(false);
  });

  it("any type with roadState closed closes; lane closures alone do not", () => {
    expect(isEdgeClosure({ type: "roadworks", roadState: "closed" })).toBe(true);
    expect(isEdgeClosure({ type: "lane_closure" })).toBe(false);
    expect(isEdgeClosure({ type: "lane_closure", roadState: "some_lanes_closed" })).toBe(false);
    expect(isEdgeClosure({ type: "accident", roadState: undefined })).toBe(false);
  });

  it("vehicle-scoped closures never close an edge for everyone", () => {
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["truck"] })).toBe(false);
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["truck", "car"] })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: [] })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["all_vehicles"] })).toBe(true);
  });

  it("matches vehicle classes case-insensitively", () => {
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["Passenger_Car"] })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["TRUCK"] })).toBe(false);
  });

  it("matches DATEX camelCase and hyphenated spellings of the same class", () => {
    // DATEX II names these classes in camelCase; a spelling we fail to
    // recognise would silently downgrade a full closure to "lorries only".
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["anyVehicle"] })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["passengerCar"] })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["PASSENGER_CAR"] })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["motor-vehicle"] })).toBe(true);
    expect(isEdgeClosure({ type: "road_closure", vehiclesAffected: ["heavyGoodsVehicle"] })).toBe(
      false,
    );
  });

  it("keeps the exported class list in its public snake_case form", () => {
    expect(PASSENGER_CAR_CLASSES.has("passenger_car")).toBe(true);
    expect(PASSENGER_CAR_CLASSES.has("any_vehicle")).toBe(true);
  });

  it("treats a null vehicle scope as affecting everyone", () => {
    expect(isEdgeClosure({ type: "road_closure", roadState: null, vehiclesAffected: null })).toBe(
      true,
    );
  });
});

describe("isRoutingRelevantBinding", () => {
  it("accepts exact and likely only", () => {
    expect(isRoutingRelevantBinding("exact")).toBe(true);
    expect(isRoutingRelevantBinding("likely")).toBe(true);
    expect(isRoutingRelevantBinding("ambiguous")).toBe(false);
    expect(isRoutingRelevantBinding(undefined)).toBe(false);
  });

  it("rejects the remaining statuses", () => {
    expect(isRoutingRelevantBinding("unresolved")).toBe(false);
    expect(isRoutingRelevantBinding("no_coverage")).toBe(false);
    expect(isRoutingRelevantBinding("not_applicable")).toBe(false);
  });
});
