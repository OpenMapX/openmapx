import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The generator keeps the last millisecond and sequence at module level, so
// every test takes a fresh module and none depends on another's clock.
let uuidv7: typeof import("./uuidv7").uuidv7;

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function timestampOf(id: string): number {
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

describe("uuidv7", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ uuidv7 } = await import("./uuidv7"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets the version 7 and RFC 9562 variant bits", () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv7();
      expect(id).toMatch(FORMAT);
      expect(id.charAt(14)).toBe("7");
      expect(["8", "9", "a", "b"]).toContain(id.charAt(19));
    }
  });

  it("puts the Unix milliseconds in the first 48 bits", () => {
    const at = Date.UTC(2031, 4, 6, 7, 8, 9, 123);
    expect(timestampOf(uuidv7(at))).toBe(at);
    expect(uuidv7(at).slice(0, 13)).toBe("01c2b7b9-c823");

    const before = Date.now();
    const fromClock = timestampOf(uuidv7());
    expect(fromClock).toBeGreaterThanOrEqual(before);
    expect(fromClock).toBeLessThanOrEqual(Date.now());
  });

  it("orders ids made within one millisecond by creation", () => {
    vi.useFakeTimers({ now: Date.UTC(2032, 0, 1), toFake: ["Date"] });
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(timestampOf(ids[0] ?? "")).toBe(Date.UTC(2032, 0, 1));
  });

  it("keeps the order when the clock steps back", () => {
    vi.useFakeTimers({ now: Date.UTC(2033, 0, 1, 0, 0, 1), toFake: ["Date"] });
    const first = uuidv7();
    vi.setSystemTime(Date.UTC(2033, 0, 1));
    const second = uuidv7();
    expect(second > first).toBe(true);
  });

  it("is random beyond the timestamp", () => {
    const at = Date.UTC(2030, 0, 1);
    expect(uuidv7(at)).not.toBe(uuidv7(at));
  });
});
