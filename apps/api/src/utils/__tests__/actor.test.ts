import { describe, expect, it } from "vitest";
import { dbActorId, LOOPBACK_ACTOR_ID } from "../actor";

describe("dbActorId", () => {
  it("nulls the synthetic loopback actor (no user row to FK against)", () => {
    expect(dbActorId(LOOPBACK_ACTOR_ID)).toBeNull();
  });

  it("nulls null/undefined/empty", () => {
    expect(dbActorId(null)).toBeNull();
    expect(dbActorId(undefined)).toBeNull();
    expect(dbActorId("")).toBeNull();
  });

  it("passes a real user id through", () => {
    expect(dbActorId("user_abc123")).toBe("user_abc123");
  });
});
