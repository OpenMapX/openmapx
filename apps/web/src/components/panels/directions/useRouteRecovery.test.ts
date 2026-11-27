import { describe, expect, it } from "vitest";
import { type RecoveryEngine, routeRecoveryOptions } from "./useRouteRecovery";

const engine = (id: string, overrides: Partial<RecoveryEngine> = {}): RecoveryEngine => ({
  id,
  name: id,
  available: true,
  modes: ["driving"],
  timeAware: true,
  exclusions: true,
  ...overrides,
});
const request = { mode: "driving" as const, scheduled: false, avoidIncidents: false };

describe("route recovery options", () => {
  it("offers another engine when the failed one is not the only available engine", () => {
    expect(
      routeRecoveryOptions({
        ...request,
        failed: "routing-valhalla",
        engines: [engine("routing-valhalla"), engine("routing-acme", { name: "Acme Router" })],
      }).engines,
    ).toContainEqual(
      expect.objectContaining({
        kind: "other-engine",
        integrationId: "routing-acme",
        name: "Acme Router",
      }),
    );
  });

  it("does not offer the engine that failed, an unavailable one, or one for another mode", () => {
    expect(
      routeRecoveryOptions({
        ...request,
        failed: "routing-valhalla",
        engines: [
          engine("routing-valhalla"),
          engine("routing-down", { available: false }),
          engine("routing-bike", { modes: ["cycling"] }),
        ],
      }).engines,
    ).toEqual([]);
  });

  it("does not offer an engine that cannot honour the schedule", () => {
    expect(
      routeRecoveryOptions({
        ...request,
        scheduled: true,
        failed: "routing-valhalla",
        engines: [engine("routing-valhalla"), engine("routing-acme", { timeAware: false })],
      }).engines,
    ).toEqual([]);
  });

  it("does not offer an engine that cannot avoid incidents when they are avoided", () => {
    expect(
      routeRecoveryOptions({
        ...request,
        avoidIncidents: true,
        failed: "routing-valhalla",
        engines: [engine("routing-valhalla"), engine("routing-acme", { exclusions: false })],
      }).engines,
    ).toEqual([]);
  });

  it("offers no engine switch while the failed engine is unknown", () => {
    expect(
      routeRecoveryOptions({ ...request, failed: undefined, engines: [engine("routing-acme")] })
        .engines,
    ).toEqual([]);
  });

  it("offers each other ground mode some available engine can plan with the trip settings", () => {
    const engines = [
      engine("routing-car", { modes: ["driving"], timeAware: false, exclusions: false }),
      engine("routing-all", {
        modes: ["driving", "walking", "cycling", "motorcycle"],
      }),
      engine("routing-off", { available: false, modes: ["walking"] }),
    ];
    expect(
      routeRecoveryOptions({ ...request, mode: "walking", failed: undefined, engines }).modes,
    ).toEqual(["cycling", "driving", "motorcycle"]);
    expect(
      routeRecoveryOptions({
        ...request,
        mode: "walking",
        failed: undefined,
        engines: [engines[0] as RecoveryEngine],
      }).modes,
    ).toEqual(["driving"]);
    expect(
      routeRecoveryOptions({
        ...request,
        mode: "walking",
        avoidIncidents: true,
        failed: undefined,
        engines: [engines[0] as RecoveryEngine],
      }).modes,
    ).toEqual([]);
  });
});
