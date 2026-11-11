import { FakeClock } from "../navigation/testing/foregroundHarness";
import { ConfirmedConnectivity } from "./ConfirmedConnectivity";
import { CONNECTIVITY_DEBOUNCE_MS, type ConnectivityState } from "./ConnectivityDriver";

function setup(initial: ConnectivityState = "unknown") {
  const clock = new FakeClock();
  let listener: (state: ConnectivityState) => void = () => {};
  let state = initial;
  const confirmed = new ConfirmedConnectivity({
    driver: {
      current: () => state,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = () => {};
        };
      },
    },
    now: clock.now,
    schedule: clock.schedule,
  });
  const changes: ConnectivityState[] = [];
  confirmed.onConfirmed(() => changes.push(confirmed.confirmed()));
  const stop = confirmed.start();
  const report = (next: ConnectivityState) => {
    state = next;
    listener(next);
  };
  return { clock, confirmed, changes, report, stop };
}

describe("ConfirmedConnectivity", () => {
  it("confirms a reading once it has held, without a second report", () => {
    const { clock, confirmed, changes, report } = setup("online");
    clock.advance(CONNECTIVITY_DEBOUNCE_MS);
    report("offline");
    clock.advance(CONNECTIVITY_DEBOUNCE_MS - 1);
    expect(confirmed.confirmed()).toBe("online");
    clock.advance(1);
    expect(changes).toEqual(["online", "offline"]);
  });

  it("ignores a flap shorter than the debounce", () => {
    const { clock, changes, report } = setup("online");
    clock.advance(CONNECTIVITY_DEBOUNCE_MS);
    report("offline");
    clock.advance(1_000);
    report("online");
    clock.advance(CONNECTIVITY_DEBOUNCE_MS * 3);
    expect(changes).toEqual(["online"]);
  });

  it("confirms on read when timers did not run", () => {
    const { clock, confirmed, report } = setup("online");
    clock.timersPaused = true;
    report("offline");
    clock.advance(CONNECTIVITY_DEBOUNCE_MS);
    expect(confirmed.confirmed()).toBe("offline");
  });

  it("stops following the platform when stopped", () => {
    const { clock, changes, report, stop } = setup("online");
    stop();
    report("offline");
    clock.advance(CONNECTIVITY_DEBOUNCE_MS * 2);
    expect(changes).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
  });
});
