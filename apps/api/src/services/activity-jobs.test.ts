import { describe, expect, it } from "vitest";
import { normalizeDataManagerJobStatus, parseDataManagerActor } from "./activity-jobs.js";

describe("activity job normalization", () => {
  it.each([
    ["ok", "success"],
    ["error", "failed"],
    ["running", "running"],
    ["partial", "partial"],
    ["interrupted", "interrupted"],
  ])("normalizes data-manager status %s to %s", (input, expected) => {
    expect(normalizeDataManagerJobStatus(input)).toBe(expected);
  });

  it.each([
    ["api:user:user-1", "user-1", "Administrator"],
    ["manual:admin:user-2", "user-2", "Administrator"],
    ["cron:data-manager-cron", null, "Scheduled"],
    ["bootstrap", null, "Bootstrap"],
    ["data-manager-auto-bump", null, "Automatic version bump"],
    [null, null, "System"],
  ])("parses data-manager actor %s", (triggeredBy, userId, label) => {
    expect(parseDataManagerActor(triggeredBy)).toEqual({ userId, label });
  });
});
