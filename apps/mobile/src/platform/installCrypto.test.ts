const mockGetRandomValues = jest.fn(<T extends ArrayBufferView>(array: T): T => {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  bytes.fill(7);
  return array;
});

jest.mock("expo-crypto", () => ({
  getRandomValues: (array: ArrayBufferView) => mockGetRandomValues(array),
}));

import { installCrypto } from "./installCrypto";

describe("installCrypto", () => {
  beforeEach(() => mockGetRandomValues.mockClear());

  it("installs getRandomValues on a runtime without crypto", () => {
    const scope: { crypto?: { getRandomValues(array: Uint8Array): Uint8Array } } = {};
    installCrypto(scope);

    const filled = scope.crypto?.getRandomValues(new Uint8Array(4));

    expect(Array.from(filled ?? [])).toEqual([7, 7, 7, 7]);
    expect(mockGetRandomValues).toHaveBeenCalledTimes(1);
  });

  it("adds getRandomValues to a crypto object that lacks it", () => {
    const existing: { subtle: string; getRandomValues?: (array: Uint8Array) => Uint8Array } = {
      subtle: "kept",
    };
    const scope = { crypto: existing };
    installCrypto(scope);

    expect(scope.crypto).toBe(existing);
    expect(existing.subtle).toBe("kept");
    expect(Array.from(existing.getRandomValues?.(new Uint8Array(2)) ?? [])).toEqual([7, 7]);
  });

  it("keeps a runtime's own implementation", () => {
    const own = jest.fn((array: Uint8Array) => array);
    const scope = { crypto: { getRandomValues: own } };
    installCrypto(scope);

    scope.crypto.getRandomValues(new Uint8Array(1));

    expect(own).toHaveBeenCalledTimes(1);
    expect(mockGetRandomValues).not.toHaveBeenCalled();
  });

  it("refuses arrays that Web Crypto refuses", () => {
    const scope: { crypto?: { getRandomValues(array: unknown): unknown } } = {};
    installCrypto(scope);

    expect(() => scope.crypto?.getRandomValues(new Float32Array(2))).toThrow(TypeError);
  });
});
