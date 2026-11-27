import { describe, expect, it } from "vitest";
import { describeThrown, loggableThrown, UNPRINTABLE_THROWN_VALUE } from "./thrown";

/** A proxy over a frozen object whose every trap throws. */
function hostileProxy(): unknown {
  const fail = () => {
    throw new Error("trap");
  };
  return new Proxy(Object.freeze({}), {
    get: fail,
    has: fail,
    ownKeys: fail,
    getPrototypeOf: fail,
    getOwnPropertyDescriptor: fail,
  });
}

class ThrowingMessage extends Error {
  override get message(): string {
    throw new Error("getter");
  }
}

describe("describeThrown", () => {
  it.each([
    ["an Error", new Error("broken"), "broken"],
    ["a string", "plain text", "plain text"],
    ["undefined", undefined, "undefined"],
    ["null", null, "null"],
    ["a number", 42, "42"],
    ["a symbol", Symbol("odd"), "Symbol(odd)"],
    ["an Error whose message is not a string", Object.assign(new Error(), { message: 7 }), "7"],
    ["an object without a prototype", Object.create(null), UNPRINTABLE_THROWN_VALUE],
    ["an Error whose message getter throws", new ThrowingMessage(), UNPRINTABLE_THROWN_VALUE],
    ["a proxy that throws on every access", hostileProxy(), UNPRINTABLE_THROWN_VALUE],
    [
      "an object whose toString throws",
      {
        toString() {
          throw new Error("no");
        },
      },
      UNPRINTABLE_THROWN_VALUE,
    ],
  ])("describes %s without throwing", (_label, value, text) => {
    expect(describeThrown(value)).toBe(text);
  });
});

describe("loggableThrown", () => {
  it("passes a readable Error through and describes anything else", () => {
    const error = new Error("broken");
    expect(loggableThrown(error)).toBe(error);
    expect(loggableThrown(new ThrowingMessage())).toBe(UNPRINTABLE_THROWN_VALUE);
    expect(loggableThrown(hostileProxy())).toBe(UNPRINTABLE_THROWN_VALUE);
    expect(loggableThrown(Object.create(null))).toBe(UNPRINTABLE_THROWN_VALUE);
    expect(loggableThrown("text")).toBe("text");
  });
});
