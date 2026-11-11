import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { groundFullSnapshot, groundProgressSnapshot } from "./groundSnapshot";
import {
  PROGRESS_INTERVAL_MS,
  type PublishableSnapshot,
  SnapshotPublisher,
} from "./SnapshotPublisher";

const START = 1_700_000_100_000;

function harness(options: { connected?: boolean } = {}) {
  const delivered: PublishableSnapshot[] = [];
  let connected = options.connected !== false;
  let now = START;

  const publisher = new SnapshotPublisher({
    deliver: (snapshot) => {
      if (!connected) return false;
      delivered.push(snapshot);
      return true;
    },
    now: () => now,
  });

  return {
    publisher,
    delivered,
    advance: (ms: number) => {
      now += ms;
    },
    disconnect: () => {
      connected = false;
    },
    reconnect: () => {
      connected = true;
    },
  };
}

const progressAt = (revision: number) =>
  groundProgressSnapshot(groundSessionFixture({ status: "active", revision }));
const fullAt = (revision: number) =>
  groundFullSnapshot(groundSessionFixture({ status: "active", revision }));

describe("SnapshotPublisher throttling", () => {
  it("sends the first progress snapshot immediately", () => {
    const { publisher, delivered } = harness();

    expect(publisher.offer(progressAt(1))).toBe("sent");
    expect(delivered).toHaveLength(1);
  });

  it("emits at most one progress snapshot per second at 5 Hz", () => {
    const { publisher, delivered, advance } = harness();

    // Five seconds of input at 200ms intervals.
    for (let tick = 0; tick < 25; tick += 1) {
      publisher.offer(progressAt(tick + 1));
      advance(200);
    }

    expect(delivered.map((s) => s.revision)).toEqual([1, 6, 11, 16, 21]);
  });

  it("drops a throttled snapshot and sends the next one after the interval", () => {
    const { publisher, delivered, advance } = harness();
    publisher.offer(progressAt(1));

    expect(publisher.offer(progressAt(2))).toBe("throttled");
    advance(PROGRESS_INTERVAL_MS - 1);
    expect(publisher.offer(progressAt(3))).toBe("throttled");
    advance(1);
    expect(publisher.offer(progressAt(4))).toBe("sent");

    // The page accepts revision 4 after 1: progress snapshots are absolute.
    expect(delivered.map((s) => s.revision)).toEqual([1, 4]);
  });
});

describe("SnapshotPublisher immediate delivery", () => {
  it("sends a full snapshot without waiting for the interval", () => {
    const { publisher, delivered } = harness();
    publisher.offer(progressAt(1));

    expect(publisher.offer(fullAt(2))).toBe("sent");
    expect(delivered).toHaveLength(2);
  });

  it("sends a critical progress snapshot without waiting", () => {
    const { publisher, delivered } = harness();
    publisher.offer(progressAt(1));

    expect(publisher.offer(progressAt(2), { immediate: true })).toBe("sent");
    expect(delivered).toHaveLength(2);
  });
});

describe("SnapshotPublisher while the page is unavailable", () => {
  it("queues nothing across a ten-second disconnection", () => {
    const { publisher, delivered, advance, disconnect, reconnect } = harness();
    disconnect();

    for (let second = 0; second < 10; second += 1) {
      publisher.offer(progressAt(second + 1));
      advance(1_000);
    }
    reconnect();

    // Ten positions delivered on reconnect would animate the user backwards
    // through where they used to be.
    expect(delivered).toEqual([]);
    expect(publisher.offer(progressAt(11))).toBe("sent");
  });

  it("reports a dropped snapshot rather than pretending it was sent", () => {
    const { publisher, disconnect } = harness();
    disconnect();

    expect(publisher.offer(progressAt(1))).toBe("dropped");
    expect(publisher.offer(fullAt(2))).toBe("dropped");
  });
});
