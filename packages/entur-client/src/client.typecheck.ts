import { encodeGraphQlRequest } from "@openmapx/mobility-formats/entur/graphql.js";
import { HealthCheckDocument } from "@openmapx/mobility-formats/entur/journey-planner.generated.js";
import type { EnturClient } from "./client";

/** Compiled by check-types, never executed; protects generated variable inference. */
export function verifyGeneratedVariableInference(client: EnturClient, signal: AbortSignal): void {
  void client.graphQl("journeyPlanner", HealthCheckDocument, { id: "NSR:StopPlace:1" }, signal);
  // @ts-expect-error The generated operation requires a string ID.
  void client.graphQl("journeyPlanner", HealthCheckDocument, { id: 1 }, signal);
  // @ts-expect-error Variables cannot invent a new property or omit required ID.
  void client.graphQl("journeyPlanner", HealthCheckDocument, { invented: true }, signal);
  // @ts-expect-error The pure serializer keeps the same generated variable constraint.
  encodeGraphQlRequest(HealthCheckDocument, { id: false });
}
