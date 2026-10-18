import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheInvalidation } from "../cache-invalidation";

// Redis is the external boundary; listeners, epochs and lifecycle use the real host.
class Subscriber extends EventEmitter {
  status = "ready";
  disconnected = false;
  acknowledged = true;
  pingFails = false;
  pingHangs = false;
  unsubscribeHangs = false;
  async subscribe(_channel: string) {
    if (!this.acknowledged) throw new Error("subscription unavailable");
    return 1;
  }
  async unsubscribe(_channel: string) {
    if (this.unsubscribeHangs) return new Promise(() => {});
    return 0;
  }
  async ping() {
    if (this.pingFails) throw new Error("heartbeat failed");
    if (this.pingHangs) return new Promise(() => {});
    return "PONG";
  }
  disconnect() {
    this.disconnected = true;
  }
}
class RedisBoundary {
  values = new Map<string, string>();
  subscribers: Subscriber[] = [];
  failIncrement = false;
  failPublish = false;
  failRead = false;
  readHangs = false;
  writeHangs = false;
  publishHangs = false;
  leases = new Map<string, number>();
  failRenew = false;
  duplicate() {
    const subscriber = new Subscriber();
    this.subscribers.push(subscriber);
    return subscriber;
  }
  async get(key: string) {
    if (this.failRead) throw new Error("read unavailable");
    if (this.readHangs) return new Promise<never>(() => {});
    return this.values.get(key) ?? null;
  }
  async incr(key: string) {
    if (this.failIncrement) throw new Error("epoch unavailable");
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, String(next));
    return next;
  }
  async publish(channel: string, message: string) {
    if (this.failPublish) throw new Error("broadcast unavailable");
    if (this.publishHangs) return new Promise<never>(() => {});
    for (const subscriber of this.subscribers) subscriber.emit("message", channel, message);
    return this.subscribers.length;
  }
  async eval(script: string, _keys: number, ...args: (string | number)[]) {
    const [epochKey, key, ...parameters] = args as [string, string, ...(string | number)[]];
    if (script.startsWith("-- begin-clear")) {
      if (this.failIncrement) throw new Error("epoch unavailable");
      this.leases.set(String(parameters[0]), Date.now() + Number(parameters[1]));
      return this.incr(epochKey);
    }
    if (script.startsWith("-- renew-clear")) {
      if (this.failRenew) throw new Error("lease renewal unavailable");
      const token = String(parameters[0]);
      if ((this.leases.get(token) ?? 0) <= Date.now()) return 0;
      this.leases.set(token, Date.now() + Number(parameters[1]));
      return 1;
    }
    if (script.startsWith("-- finish-clear")) {
      if (this.failIncrement) throw new Error("epoch unavailable");
      const token = String(parameters[0]);
      const valid = (this.leases.get(token) ?? 0) > Date.now();
      this.leases.delete(token);
      await this.incr(epochKey);
      return valid ? 1 : 0;
    }
    if (this.writeHangs) return new Promise<never>(() => {});
    if (_keys === 3) parameters.shift();
    const [epoch, value, ttl] = parameters;
    for (const [token, expiry] of this.leases) {
      if (expiry <= Date.now()) this.leases.delete(token);
    }
    if (this.leases.size > 0 || (this.values.get(epochKey) ?? "0") !== epoch) return 0;
    if (Number(ttl) <= 0) throw new Error("invalid TTL");
    this.values.set(key, String(value));
    return 1;
  }
}
const hosts: CacheInvalidation[] = [];
function host(redis: RedisBoundary | null = null) {
  const value = new CacheInvalidation(redis);
  hosts.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((value) => value.stop()));
  vi.useRealTimers();
});

describe("host cache invalidation", () => {
  it("clears only overlapping local namespaces and detaches listeners without Redis", async () => {
    const value = host();
    const geocoding: boolean[] = [];
    const routing: boolean[] = [];
    const unsubscribe = value.subscribe("int:geocoding:", (event) =>
      geocoding.push(event.available),
    );
    value.subscribe("int:routing:", (event) => routing.push(event.available));
    const before = await value.captureEpoch();
    expect(await value.invalidate(["int:geocoding:country:*"], async () => 7)).toBe(7);
    expect(geocoding).toEqual([true, true, true]);
    expect(routing).toEqual([true]);
    expect(await value.captureEpoch()).not.toBe(before);
    unsubscribe();
    await value.invalidate(["int:*", "cache:*"], async () => undefined);
    expect(geocoding).toEqual([true, true, true]);
    expect(routing).toEqual([true, true, true]);
  });

  it("conservatively purges scopes when a glob intersects their literal prefix", async () => {
    const value = host();
    let events = 0;
    value.subscribe("int:geocoding:", () => events++);
    await value.invalidate(["int:geo[cr]*"], async () => undefined);
    expect(events).toBe(3);
  });

  it("fences writes captured before or during deletion while allowing later fills", async () => {
    const redis = new RedisBoundary();
    const value = host(redis);
    const old = await value.captureEpoch();
    let during: string | null = null;
    await value.invalidate(["int:*"], async () => {
      during = await value.captureEpoch();
      redis.values.delete("int:geocoding:a");
    });
    await value.writeIfCurrent("int:geocoding:a", "old", 60, old);
    await value.writeIfCurrent("int:geocoding:a", "during", 60, during);
    expect(redis.values.has("int:geocoding:a")).toBe(false);
    await value.writeIfCurrent("int:geocoding:a", "new", 60, await value.captureEpoch());
    expect(redis.values.get("int:geocoding:a")).toBe("new");
    expect(
      [...redis.values.keys()].filter((key) => key.startsWith("int:") || key.startsWith("cache:")),
    ).toEqual(["int:geocoding:a"]);
  });

  it("refuses a new fill while deletion is still in progress", async () => {
    const redis = new RedisBoundary();
    const value = host(redis);
    await value.invalidate(["int:*"], async () => {
      const during = await value.captureEpoch();
      await value.writeIfCurrent("int:geocoding:already-scanned", "during", 60, during);
      expect(redis.values.has("int:geocoding:already-scanned")).toBe(false);
    });
  });

  it("keeps shared writes blocked until every concurrent clear finishes", async () => {
    const redis = new RedisBoundary();
    const first = host(redis);
    const second = host(redis);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = first.invalidate(["int:*"], async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    await second.invalidate(["cache:*"], async () => undefined);
    await second.writeIfCurrent("int:geocoding:a", "blocked", 60, await second.captureEpoch());
    expect(redis.values.has("int:geocoding:a")).toBe(false);
    release.resolve();
    await pending;
    await second.writeIfCurrent("int:geocoding:a", "fresh", 60, await second.captureEpoch());
    expect(redis.values.get("int:geocoding:a")).toBe("fresh");
  });

  it("recovers writes after an abandoned clear lease expires", async () => {
    vi.useFakeTimers();
    const redis = new RedisBoundary();
    const value = host(redis);
    redis.leases.set("crashed-worker", Date.now() + 30_000);
    await value.writeIfCurrent("int:geocoding:a", "blocked", 60, await value.captureEpoch());
    expect(redis.values.has("int:geocoding:a")).toBe(false);
    await vi.advanceTimersByTimeAsync(30_001);
    await value.writeIfCurrent("int:geocoding:a", "fresh", 60, await value.captureEpoch());
    expect(redis.values.get("int:geocoding:a")).toBe("fresh");
  });

  it("renews a long-running clear lease", async () => {
    vi.useFakeTimers();
    const redis = new RedisBoundary();
    const value = host(redis);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = value.invalidate(["int:*"], async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    await value.writeIfCurrent("int:geocoding:a", "blocked", 60, await value.captureEpoch());
    expect(redis.values.has("int:geocoding:a")).toBe(false);
    release.resolve();
    await pending;
    expect(redis.leases.size).toBe(0);
  });

  it("fails a clear that loses its lease instead of reporting success", async () => {
    vi.useFakeTimers();
    const redis = new RedisBoundary();
    const value = host(redis);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = value.invalidate(["int:*"], async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;
    redis.failRenew = true;
    await vi.advanceTimersByTimeAsync(35_000);
    release.resolve();
    await expect(pending).rejects.toThrow(/lease/i);
  });

  it("notifies both workers before and after a clear and after failed deletion", async () => {
    const redis = new RedisBoundary();
    const a = host(redis);
    const b = host(redis);
    await a.start();
    await b.start();
    const events: boolean[] = [];
    b.subscribe("int:geocoding:", (event) => events.push(event.available));
    await a.invalidate(["int:geocoding:*"], async () => {
      expect(events).toEqual([true, true]);
    });
    expect(events).toEqual([true, true, true]);
    await expect(
      a.invalidate(["int:*"], async () => {
        throw new Error("delete failed");
      }),
    ).rejects.toThrow("delete failed");
    expect(events).toEqual([true, true, true, true, true]);
  });

  it("fails closed when epoch advancement or broadcasting fails", async () => {
    const redis = new RedisBoundary();
    const value = host(redis);
    let deleted = false;
    redis.failIncrement = true;
    await expect(
      value.invalidate(["int:*"], async () => {
        deleted = true;
      }),
    ).rejects.toThrow("epoch unavailable");
    expect(deleted).toBe(false);
    redis.failIncrement = false;
    redis.failPublish = true;
    await expect(
      value.invalidate(["int:*"], async () => {
        deleted = true;
      }),
    ).rejects.toThrow("broadcast unavailable");
    expect(deleted).toBe(false);
  });

  it("disables local caching on missed messages until a new subscription is acknowledged", async () => {
    const redis = new RedisBoundary();
    const value = host(redis);
    const events: boolean[] = [];
    value.subscribe("int:geocoding:", (event) => events.push(event.available));
    expect(events).toEqual([false]);
    await value.start();
    expect(events).toEqual([false, true]);
    const subscriber = redis.subscribers[0];
    if (!subscriber) throw new Error("Subscriber was not started");
    subscriber.emit("close");
    expect(events.at(-1)).toBe(false);
    subscriber.acknowledged = false;
    subscriber.emit("ready");
    await Promise.resolve();
    await Promise.resolve();
    expect(events.at(-1)).toBe(false);
    subscriber.acknowledged = true;
    subscriber.emit("ready");
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(events.at(-1)).toBe(true));
    await value.stop();
    expect(events.at(-1)).toBe(false);
    expect(subscriber.disconnected).toBe(true);
    expect(subscriber.eventNames()).toEqual([]);
  });

  it("bounds epoch reads and guarded writes on a half-open Redis connection", async () => {
    vi.useFakeTimers();
    const redis = new RedisBoundary();
    const value = host(redis);
    redis.readHangs = true;
    const capture = value.captureEpoch();
    await vi.advanceTimersByTimeAsync(3_000);
    let captured = false;
    void capture.then(() => {
      captured = true;
    });
    await Promise.resolve();
    expect(captured).toBe(true);
    expect(await capture).toBe(null);
    redis.readHangs = false;
    redis.writeHangs = true;
    const writing = value
      .writeIfCurrent("int:geocoding:a", "value", 60, "0")
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(3_000);
    let written = false;
    void writing.then(() => {
      written = true;
    });
    await Promise.resolve();
    expect(written).toBe(true);
    expect(await writing).toBeInstanceOf(Error);
  });

  it("fails a clear within a bounded time when publication never replies", async () => {
    vi.useFakeTimers();
    const redis = new RedisBoundary();
    const value = host(redis);
    redis.publishHangs = true;
    let deleted = false;
    const clearing = value
      .invalidate(["int:*"], async () => {
        deleted = true;
      })
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(6_000);
    let completed = false;
    void clearing.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(true);
    expect(await clearing).toBeInstanceOf(Error);
    expect(deleted).toBe(false);
    expect(redis.leases.size).toBe(0);
  });

  it("skips a shared write after an unsuccessful epoch capture", async () => {
    const redis = new RedisBoundary();
    const value = host(redis);
    redis.failRead = true;
    const epoch = await value.captureEpoch();
    expect(epoch).toBe(null);
    await value.writeIfCurrent("int:geocoding:a", "unsafe", 60, epoch);
    expect(redis.values.has("int:geocoding:a")).toBe(false);
  });

  it("times out silent heartbeat loss and can stop without a Redis reply", async () => {
    vi.useFakeTimers();
    const redis = new RedisBoundary();
    const value = host(redis);
    await value.start();
    const events: boolean[] = [];
    value.subscribe("int:geocoding:", (event) => events.push(event.available));
    const subscriber = redis.subscribers[0];
    if (!subscriber) throw new Error("Subscriber was not started");
    subscriber.pingHangs = true;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(events).toEqual([true, false]);
    subscriber.unsubscribeHangs = true;
    let stopped = false;
    const stopping = value.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(true);
    await stopping;
    expect(subscriber.disconnected).toBe(true);
  });

  it("detects an unannounced dead subscriber by heartbeat", async () => {
    vi.useFakeTimers();
    const redis = new RedisBoundary();
    const value = host(redis);
    await value.start();
    const events: boolean[] = [];
    value.subscribe("int:geocoding:", (event) => events.push(event.available));
    const subscriber = redis.subscribers[0];
    if (!subscriber) throw new Error("Subscriber was not started");
    subscriber.pingFails = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([true, false]);
  });
});
