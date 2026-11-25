import { describe, expect, it } from "vitest";
import { dataManagerActor } from "./activity-jobs.js";

describe("data-manager job actor", () => {
  it.each([
    ["api", "user-1", "user-1", "Administrator"],
    ["api", null, null, "API"],
    ["agent", null, null, "Operations agent"],
    ["cli", null, null, "Host CLI"],
    ["cron", null, null, "Scheduled"],
    ["bootstrap", null, null, "Bootstrap"],
  ] as const)("names a %s job started for %s", (trigger, triggeredByUserId, userId, label) => {
    expect(dataManagerActor(trigger, triggeredByUserId)).toEqual({ userId, label });
  });
});
