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
      publisher.flushPending();
    }

    expect(delivered.length).toBeLessThanOrEqual(6);
  });

  it("delivers the newest snapshot, not the one that was throttled first", () => {
    const { publisher, delivered, advance } = harness();
    publisher.offer(progressAt(1));

    publisher.offer(progressAt(2));
    publisher.offer(progressAt(3));
    publisher.offer(progressAt(4));
    advance(PROGRESS_INTERVAL_MS);
    publisher.flushPending();

    expect(delivered.map((s) => s.revision)).toEqual([1, 4]);
  });

  it("holds at most one snapshot back at a time", () => {
    const { publisher } = harness();
    publisher.offer(progressAt(1));

    for (let revision = 2; revision < 50; revision += 1) publisher.offer(progressAt(revision));

    expect(publisher.hasPending).toBe(true);
  });

  it("does not deliver early when the interval has not elapsed", () => {
    const { publisher, delivered, advance } = harness();
    publisher.offer(progressAt(1));
    publisher.offer(progressAt(2));

    advance(PROGRESS_INTERVAL_MS - 1);

    expect(publisher.flushPending()).toBe(false);
    expect(delivered).toHaveLength(1);
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

  it("clears anything throttled when an immediate snapshot supersedes it", () => {
    const { publisher } = harness();
    publisher.offer(progressAt(1));
    publisher.offer(progressAt(2));

    publisher.offer(fullAt(3));

    expect(publisher.hasPending).toBe(false);
  });
});

describe("SnapshotPublisher while the page is unavailable", () => {
  it("queues nothing across a ten-second disconnection", () => {
    const { publisher, delivered, advance, disconnect, reconnect } = harness();
    disconnect();

    for (let second = 0; second < 10; second += 1) {
      publisher.offer(progressAt(second + 1));
      advance(1_000);
      publisher.flushPending();
    }
    reconnect();
    publisher.flushPending();

    // Ten positions delivered on reconnect would animate the user backwards
    // through where they used to be.
    expect(delivered).toEqual([]);
  });

  it("reports a dropped snapshot rather than pretending it was sent", () => {
    const { publisher, disconnect } = harness();
    disconnect();

    expect(publisher.offer(progressAt(1))).toBe("dropped");
    expect(publisher.offer(fullAt(2))).toBe("dropped");
  });

  it("sends a fresh full snapshot after the page comes back", () => {
    const { publisher, delivered, disconnect, reconnect } = harness();
    disconnect();
    publisher.offer(progressAt(1));
    reconnect();
    publisher.reset();

    publisher.offer(fullAt(9));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].type).toBe("full");
    expect(delivered[0].revision).toBe(9);
  });

  it("does not hold the first snapshot of a new document behind an old timer", () => {
    const { publisher, delivered } = harness();
    publisher.offer(progressAt(1));

    publisher.reset();

    expect(publisher.offer(progressAt(2))).toBe("sent");
    expect(delivered).toHaveLength(2);
  });

  it("discards what was waiting when the document is gone", () => {
    const { publisher } = harness();
    publisher.offer(progressAt(1));
    publisher.offer(progressAt(2));

    publisher.discard();

    expect(publisher.hasPending).toBe(false);
    expect(publisher.flushPending()).toBe(false);
  });
});
