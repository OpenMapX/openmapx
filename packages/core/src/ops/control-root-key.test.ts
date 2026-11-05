import { describe, expect, it } from "vitest";
import { createControlRootOperationKey, parseControlRootOperationKey } from "./control-root-key";

describe("self-describing control root keys", () => {
  it("round trips an exact canonical expiry and 128-bit nonce", () => {
    const key = createControlRootOperationKey({ notAfter: 1, nonce: new Uint8Array(16) });
    expect(key).toBe("opk1_t1_00000000000001_AAAAAAAAAAAAAAAAAAAAAA");
    expect(parseControlRootOperationKey(key)).toEqual({
      notAfter: 1,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(key).toMatch(/^opk1_[A-Za-z0-9_-]{16,64}$/);
  });
  it.each([0, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid expiry %s",
    (notAfter) => {
      expect(() =>
        createControlRootOperationKey({ notAfter, nonce: new Uint8Array(16) }),
      ).toThrow();
    },
  );
  it.each([0, 15, 17])("requires exactly sixteen nonce bytes (%s)", (length) => {
    expect(() =>
      createControlRootOperationKey({ notAfter: 1, nonce: new Uint8Array(length) }),
    ).toThrow();
  });
  it.each([
    "opk1_t1_00000000000000_AAAAAAAAAAAAAAAAAAAAAA",
    "opk1_t1_0000000000000A_AAAAAAAAAAAAAAAAAAAAAA",
    "opk1_t1_00000000000001_AAAAAAAAAAAAAAAAAAAAAB",
    "opk1_t1_00000000000001_AAAAAAAAAAAAAAAAAAAAAA=",
    "opk1_t1_20000000000000_AAAAAAAAAAAAAAAAAAAAAA",
    "opk1_abcdefghijklmnopqrstuvwxyz012345",
  ])("rejects noncanonical or unsupported root %s", (key) => {
    expect(() => parseControlRootOperationKey(key)).toThrow();
  });
});
