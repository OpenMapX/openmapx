/** What `describeThrown` answers for a value that cannot be turned into text. */
export const UNPRINTABLE_THROWN_VALUE = "a value that cannot be shown";

/**
 * Text for a value that integration code threw or rejected with. It may be
 * anything: an object without a prototype, an `Error` whose `message` getter
 * throws, a symbol or a proxy that throws on every access. This never throws.
 */
export function describeThrown(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (typeof value === "symbol") return Symbol.prototype.toString.call(value);
    if (value instanceof Error) {
      const { message } = value;
      return typeof message === "string" ? message : String(message);
    }
    return String(value);
  } catch {
    return UNPRINTABLE_THROWN_VALUE;
  }
}

/**
 * `value` for the `err` field of a log line when it is an `Error` a logger
 * can read, otherwise its description, so that logging a thrown value cannot
 * itself throw.
 */
export function loggableThrown(value: unknown): unknown {
  try {
    if (value instanceof Error) {
      const { message, name, stack } = value;
      if (typeof message === "string" && typeof name === "string" && typeof stack !== "object")
        return value;
    }
  } catch {
    // Described below.
  }
  return describeThrown(value);
}
