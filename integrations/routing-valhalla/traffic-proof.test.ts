import { describe, expect, it } from "vitest";
import { readTrafficProof } from "./traffic-proof.js";

const now = Date.parse("2026-09-11T12:00:00Z");
const proof = {
  schemaVersion: 1,
  requestId: "nonce",
  writeId: "write",
  graphGeneration: "graph",
  engineBootId: "boot",
  validUntil: "2026-09-11T12:01:00Z",
  evaluatedAt: "2026-09-11T12:00:00Z",
  endpoint: "route",
  costing: "auto",
};
describe("request-bound traffic proof", () => {
  it("accepts a matching live response", () =>
    expect(readTrafficProof(proof, "nonce", "route", "auto", now, now)).toEqual(proof));
  it.each([
    { requestId: "replay" },
    { endpoint: "optimized_route" },
    { costing: "motorcycle" },
    { validUntil: "2026-09-11T11:59:00Z" },
    { evaluatedAt: "2026-09-11T11:59:00Z" },
    { engineBootId: "" },
    { schemaVersion: 2 },
  ])("rejects mismatched or expired proof %j", (patch) =>
    expect(
      readTrafficProof({ ...proof, ...patch }, "nonce", "route", "auto", now, now),
    ).toBeUndefined(),
  );
});
