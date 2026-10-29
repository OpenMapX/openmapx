import { describe, expect, it } from "vitest";
import { decodeGraphQlEnvelope, encodeGraphQlRequest } from "./graphql";
import { HealthCheckDocument } from "./journey-planner.generated";

describe("pure Entur GraphQL envelopes", () => {
  it("serializes the authoritative document and variables", () => {
    const body = JSON.parse(encodeGraphQlRequest(HealthCheckDocument, { id: "NSR:StopPlace:1" }));
    expect(body).toEqual({
      query: HealthCheckDocument.toString(),
      variables: { id: "NSR:StopPlace:1" },
    });
  });
  it("returns data but rejects partial errors and missing data without leaking diagnostics", () => {
    expect(decodeGraphQlEnvelope<{ value: number }>(' {"data":{"value":1}} ')).toEqual({
      value: 1,
    });
    for (const text of [
      '{"data":null}',
      "{}",
      "[]",
      "null",
      "private-secret",
      '{"data":{},"errors":[{"message":"private-secret"}]}',
    ]) {
      expect(() => decodeGraphQlEnvelope(text)).toThrow();
      try {
        decodeGraphQlEnvelope(text);
      } catch (error) {
        expect(String(error)).not.toContain("private-secret");
      }
    }
    expect(decodeGraphQlEnvelope('{"data":{},"errors":[]}')).toEqual({});
  });
  it.each([{ data: false }, { data: 0 }, { data: "malformed" }, { data: [] }])(
    "rejects a non-object or array operation data root: %j",
    (envelope) => {
      expect(() => decodeGraphQlEnvelope(JSON.stringify(envelope))).toThrow(
        "Entur returned an invalid GraphQL envelope",
      );
    },
  );
  it("accepts an empty operation data object without full result validation", () => {
    expect(decodeGraphQlEnvelope('{"data":{}}')).toEqual({});
  });
});
