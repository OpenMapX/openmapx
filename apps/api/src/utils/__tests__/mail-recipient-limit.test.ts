import { describe, expect, it, vi } from "vitest";
import {
  createMailRecipientLimit,
  MAIL_RECIPIENT_HOURLY_LIMIT,
  mailRecipientKey,
  normalizeMailRecipient,
} from "../mail-recipient-limit";

/** An in-memory stand-in for the counter script: INCR, with the window set on the first hit. */
function countingStore() {
  const counts = new Map<string, number>();
  const ttl = new Map<string, number>();
  const evalCalls: unknown[][] = [];
  return {
    counts,
    ttl,
    evalCalls,
    store: {
      eval: vi.fn(async (...args: unknown[]) => {
        evalCalls.push(args);
        const key = String(args[2]);
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        if (next === 1) ttl.set(key, Number(args[3]));
        return next;
      }),
    },
  };
}

describe("per-recipient mail limit", () => {
  it("admits the hourly allowance for one address and refuses the next message", async () => {
    const { store } = countingStore();
    const limit = createMailRecipientLimit({ store });
    for (let index = 0; index < MAIL_RECIPIENT_HOURLY_LIMIT; index += 1)
      expect(await limit.admit("person@example.test")).toBe(true);
    expect(await limit.admit("person@example.test")).toBe(false);
    expect(await limit.admit("someone-else@example.test")).toBe(true);
  });

  it("counts spellings that reach the same mailbox against one allowance", async () => {
    const { store } = countingStore();
    const limit = createMailRecipientLimit({ store, limit: 2 });
    expect(await limit.admit("First.Last@Gmail.com")).toBe(true);
    expect(await limit.admit("firstlast+signup@googlemail.com")).toBe(true);
    expect(await limit.admit(" FIRSTLAST@gmail.com ")).toBe(false);
    expect(await limit.admit("first.last@example.test")).toBe(true);
  });

  it("keeps the address out of the shared store and sets an hourly window", async () => {
    const { store, evalCalls, ttl } = countingStore();
    await createMailRecipientLimit({ store }).admit("person@example.test");
    const [script, keyCount, key, windowMs] = evalCalls[0] ?? [];
    expect(typeof script).toBe("string");
    expect(keyCount).toBe(1);
    expect(key).toBe(mailRecipientKey("person@example.test"));
    expect(String(key)).toMatch(/^mail-recipient:[0-9a-f]{64}$/);
    expect(String(key)).not.toContain("person");
    expect(mailRecipientKey("person@example.test", "one-secret")).not.toBe(
      mailRecipientKey("person@example.test", "another-secret"),
    );
    expect(mailRecipientKey("Person+tag@Example.test", "one-secret")).toBe(
      mailRecipientKey("person@example.test", "one-secret"),
    );
    expect(windowMs).toBe("3600000");
    expect(ttl.get(String(key))).toBe(3_600_000);
  });

  it("lets mail through and reports it when the shared store fails, stalls or is absent", async () => {
    const unavailable = vi.fn();
    const failing = createMailRecipientLimit({
      store: { eval: vi.fn(async () => Promise.reject(new Error("connection refused"))) },
      onUnavailable: unavailable,
    });
    expect(await failing.admit("person@example.test")).toBe(true);
    const stalled = createMailRecipientLimit({
      store: { eval: vi.fn(() => new Promise<unknown>(() => {})) },
      timeoutMs: 5,
      onUnavailable: unavailable,
    });
    expect(await stalled.admit("person@example.test")).toBe(true);
    const malformed = createMailRecipientLimit({
      store: { eval: vi.fn(async () => "not a count") },
      onUnavailable: unavailable,
    });
    expect(await malformed.admit("person@example.test")).toBe(true);
    expect(unavailable).toHaveBeenCalledTimes(3);
    expect(await createMailRecipientLimit({ store: null }).admit("person@example.test")).toBe(true);
  });

  it.each([
    ["Person@Example.TEST", "person@example.test"],
    ["person+tag@example.test", "person@example.test"],
    ["p.e.r.s.o.n@gmail.com", "person@gmail.com"],
    ["person@googlemail.com", "person@gmail.com"],
    ["p.erson@example.test", "p.erson@example.test"],
  ])("normalizes %s to %s", (address, normalized) => {
    expect(normalizeMailRecipient(address)).toBe(normalized);
  });
});
