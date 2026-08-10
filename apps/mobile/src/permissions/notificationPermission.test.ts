import {
  availabilityFor,
  type NotificationEvent,
  type NotificationFlowState,
  notificationReducer,
} from "./notificationPermission";

function drive(
  events: readonly NotificationEvent[],
  from: NotificationFlowState = { state: "idle" },
) {
  let state = from;
  let effects: ReturnType<typeof notificationReducer>["effects"] = [];
  for (const event of events) {
    const transition = notificationReducer(state, event);
    state = transition.state;
    effects = transition.effects;
  }
  return { state, effects };
}

const start = (
  current: "not-determined" | "granted" | "denied",
  alertsEnabled = true,
): NotificationEvent => ({ type: "transit-start-requested", current, alertsEnabled });

describe("notificationReducer", () => {
  it("explains before it asks", () => {
    const { state, effects } = drive([start("not-determined")]);

    expect(state).toEqual({ state: "explaining" });
    expect(effects).toEqual([{ kind: "show-disclosure" }]);
  });

  it("asks nothing when the rider turned the backup off", () => {
    const { effects } = drive([start("not-determined", false)]);

    expect(effects).toEqual([{ kind: "resolved", availability: "disabled" }]);
  });

  it("asks nothing when permission is already granted", () => {
    const { state, effects } = drive([start("granted")]);

    expect(state).toEqual({ state: "granted" });
    expect(effects).toEqual([{ kind: "resolved", availability: "available" }]);
  });

  it("never asks again once the rider has refused", () => {
    const { state, effects } = drive([start("denied")]);

    expect(state).toEqual({ state: "denied", canAskAgain: false });
    expect(effects).toEqual([{ kind: "resolved", availability: "denied" }]);
  });

  it("requests only after the explanation is accepted", () => {
    const { state, effects } = drive([start("not-determined"), { type: "disclosure-accepted" }]);

    expect(state).toEqual({ state: "requesting" });
    expect(effects).toEqual([{ kind: "request-permission" }]);
  });

  it("never reaches the operating system when the explanation is declined", () => {
    const { state, effects } = drive([start("not-determined"), { type: "disclosure-declined" }]);

    expect(state).toEqual({ state: "denied", canAskAgain: true });
    expect(effects).toEqual([{ kind: "resolved", availability: "denied" }]);
  });

  it("resolves as available once granted", () => {
    const { state, effects } = drive([
      start("not-determined"),
      { type: "disclosure-accepted" },
      { type: "result", state: "granted", canAskAgain: false },
    ]);

    expect(state).toEqual({ state: "granted" });
    expect(effects).toEqual([{ kind: "resolved", availability: "available" }]);
  });

  it("resolves as denied without blocking navigation", () => {
    // A rider who declines the backup still gets guidance.
    const { state, effects } = drive([
      start("not-determined"),
      { type: "disclosure-accepted" },
      { type: "result", state: "denied", canAskAgain: false },
    ]);

    expect(state).toEqual({ state: "denied", canAskAgain: false });
    expect(effects).toEqual([{ kind: "resolved", availability: "denied" }]);
  });

  it("always ends in a resolved effect, whatever the rider chose", () => {
    const paths: NotificationEvent[][] = [
      [start("not-determined", false)],
      [start("granted")],
      [start("denied")],
      [start("not-determined"), { type: "disclosure-declined" }],
      [
        start("not-determined"),
        { type: "disclosure-accepted" },
        { type: "result", state: "granted", canAskAgain: false },
      ],
      [
        start("not-determined"),
        { type: "disclosure-accepted" },
        { type: "result", state: "denied", canAskAgain: true },
      ],
    ];

    for (const path of paths) {
      expect(drive(path).effects.some((effect) => effect.kind === "resolved")).toBe(true);
    }
  });

  it("emits at most one operating-system request per attempt", () => {
    const events: NotificationEvent[] = [
      start("not-determined"),
      { type: "disclosure-accepted" },
      { type: "result", state: "denied", canAskAgain: true },
      start("denied"),
    ];

    let state: NotificationFlowState = { state: "idle" };
    let requests = 0;
    for (const event of events) {
      const transition = notificationReducer(state, event);
      state = transition.state;
      requests += transition.effects.filter((e) => e.kind === "request-permission").length;
    }

    expect(requests).toBe(1);
  });

  it("ignores an event that does not belong to the current state", () => {
    const { state, effects } = drive([{ type: "result", state: "granted", canAskAgain: false }]);

    expect(state).toEqual({ state: "idle" });
    expect(effects).toEqual([]);
  });
});

describe("availabilityFor", () => {
  it("reports the backup as disabled when the rider turned it off", () => {
    expect(availabilityFor({ state: "granted" }, false)).toBe("disabled");
  });

  it("reports it as available only when granted", () => {
    expect(availabilityFor({ state: "granted" }, true)).toBe("available");
  });

  it.each([
    ["idle", { state: "idle" }],
    ["explaining", { state: "explaining" }],
    ["denied", { state: "denied", canAskAgain: false }],
  ])("reports it as denied while %s, so the page says so plainly", (_label, state) => {
    expect(availabilityFor(state as NotificationFlowState, true)).toBe("denied");
  });
});
