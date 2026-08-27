import { describe, expect, it } from "vitest";
import { opsOperationFingerprint } from "./fingerprint";

describe("operation fingerprint", () => {
  it("is stable across object key order and JSON-equivalent omitted optionals", () => {
    const canonical = {
      kind: "service.build",
      serviceId: "redis",
    } as const;
    const reordered = {
      serviceId: "redis",
      kind: "service.build",
      regionId: undefined,
    } as typeof canonical & { regionId?: undefined };

    expect(opsOperationFingerprint(reordered)).toBe(opsOperationFingerprint(canonical));
  });

  it("binds every operation option and rejects non-contract input", () => {
    const operation = {
      kind: "service.logs.follow",
      serviceId: "redis",
      tail: 20,
      maxDurationSeconds: 900,
    } as const;

    expect(opsOperationFingerprint({ ...operation, tail: 21 })).not.toBe(
      opsOperationFingerprint(operation),
    );
    expect(() =>
      opsOperationFingerprint({ ...operation, untrusted: true } as typeof operation),
    ).toThrow();
  });
});
