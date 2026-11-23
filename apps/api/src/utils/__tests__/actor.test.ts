import { describe, expect, it } from "vitest";
import { actorUserIdOrNull, LOOPBACK_ACTOR_ID } from "../actor";

describe("actorUserIdOrNull", () => {
  it("nulls the synthetic loopback actor (no user row to FK against)", () => {
    expect(actorUserIdOrNull(LOOPBACK_ACTOR_ID)).toBeNull();
  });

  it("nulls null/undefined/empty", () => {
    expect(actorUserIdOrNull(null)).toBeNull();
    expect(actorUserIdOrNull(undefined)).toBeNull();
    expect(actorUserIdOrNull("")).toBeNull();
  });

  it("passes a real user id through", () => {
    expect(actorUserIdOrNull("user_abc123")).toBe("user_abc123");
  });
});
