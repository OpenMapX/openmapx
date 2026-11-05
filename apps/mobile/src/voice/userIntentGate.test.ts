import { createUserIntentGate, USER_INTENT_WINDOW_MS } from "./userIntentGate";

describe("voice user-intent gate", () => {
  let clock = 0;
  const gate = () => createUserIntentGate(() => clock);
  beforeEach(() => {
    clock = 1_000_000;
  });

  it("refuses a start no touch preceded", () => {
    expect(gate().admit()).toBe(false);
  });

  it("admits one start per touch inside the window", () => {
    const g = gate();
    g.touched();
    clock += USER_INTENT_WINDOW_MS;
    expect(g.admit()).toBe(true);
    expect(g.admit()).toBe(false);
  });

  it("refuses a start after the window", () => {
    const g = gate();
    g.touched();
    clock += USER_INTENT_WINDOW_MS + 1;
    expect(g.admit()).toBe(false);
  });

  it("waives the touch while a screen reader is on, and only then", () => {
    const g = gate();
    g.setScreenReader(true);
    expect(g.admit()).toBe(true);
    expect(g.admit()).toBe(true);
    g.setScreenReader(false);
    expect(g.admit()).toBe(false);
  });
});
