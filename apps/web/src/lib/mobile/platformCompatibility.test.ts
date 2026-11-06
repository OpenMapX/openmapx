import type { WebToNativeMessage } from "@openmapx/core/navigation";
import { expect, it } from "vitest";
import { platformCompatibleCommand } from "./platformCompatibility";

it.each(["session.prepare", "session.replace"])(
  "strips evidence for installed v4 shells on %s only",
  (type) => {
    const stop = {
      stopId: "a",
      platform: "3",
      departurePlatform: { code: "3", kind: "correction", sourceId: "siri" },
    };
    const message = {
      protocolVersion: 4,
      type,
      payload: { startPackage: { kind: "transit", captures: [{ stops: [stop] }] } },
    } as WebToNativeMessage;
    const legacy = platformCompatibleCommand(message) as typeof message;
    expect(JSON.stringify(legacy)).not.toContain("departurePlatform");
    expect(JSON.stringify(legacy)).toContain('"platform":"3"');
    expect(platformCompatibleCommand({ ...message, protocolVersion: 5 })).toHaveProperty(
      "payload.startPackage.captures.0.stops.0.departurePlatform",
    );
    expect(stop.departurePlatform.code).toBe("3");
  },
);
