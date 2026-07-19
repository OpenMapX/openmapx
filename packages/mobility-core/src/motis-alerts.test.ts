import type { Alert } from "@motis-project/motis-client";
import { describe, expect, it } from "vitest";
import { mapMotisAlert, mapMotisAlertSeverity } from "./motis-alerts.js";

const baseAlert: Alert = {
  headerText: "Elevator out of service",
  descriptionText: "Use the stairs at platform 5.",
  severityLevel: "WARNING",
  cause: "MAINTENANCE",
  causeDetail: "Scheduled maintenance",
  url: "https://example.test/alert",
  ttsHeaderText: "Elevator out of service",
  impactPeriod: [{ start: "2026-07-15T09:00:00Z", end: "2026-07-15T18:00:00Z" }],
};

describe("mapMotisAlertSeverity", () => {
  it("maps MOTIS severity levels and defaults to info", () => {
    expect(mapMotisAlertSeverity("SEVERE")).toBe("severe");
    expect(mapMotisAlertSeverity("WARNING")).toBe("warning");
    expect(mapMotisAlertSeverity("INFO")).toBe("info");
    expect(mapMotisAlertSeverity(undefined)).toBe("info");
  });
});

describe("mapMotisAlert", () => {
  it("keeps url, cause, tts and applies the id prefix + providers", () => {
    const alert = mapMotisAlert(baseAlert, {
      idPrefix: "mr:",
      providers: ["motis-rt"],
      index: 0,
    });
    expect(alert).toMatchObject({
      id: "mr:Elevator out of service-0",
      providers: ["motis-rt"],
      severity: "warning",
      cause: "MAINTENANCE",
      title: "Elevator out of service",
      description: "Use the stairs at platform 5.",
      ttsTitle: "Elevator out of service",
      url: "https://example.test/alert",
      affectedRouteIds: [],
      affectedStopIds: [],
      activePeriods: [{ start: "2026-07-15T09:00:00Z", end: "2026-07-15T18:00:00Z" }],
    });
  });

  it("prefers the alert code for the id seed and carries affected ids", () => {
    const alert = mapMotisAlert(
      { ...baseAlert, code: "ALERT_42" },
      { idPrefix: "mr:", providers: ["motis-rt"], affectedStopIds: ["ms:koeln"] },
    );
    expect(alert.id).toBe("mr:ALERT_42");
    expect(alert.affectedStopIds).toEqual(["ms:koeln"]);
  });

  it("falls back to effectDetail when effect is absent", () => {
    const alert = mapMotisAlert(
      { ...baseAlert, effect: undefined, effectDetail: "No service" },
      {},
    );
    expect(alert.effect).toBe("No service");
  });
});
