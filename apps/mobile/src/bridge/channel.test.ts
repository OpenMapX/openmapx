import {
  CHANNEL_NONCE_BYTES,
  ChannelRegistry,
  createBridgeChannel,
  defaultRandomSource,
  MAX_SEEN_MESSAGE_IDS,
} from "./channel";

/** Deterministic but distinct per call, so nonce comparisons stay meaningful. */
function countingRandom() {
  let counter = 0;
  return (byteLength: number) => {
    counter += 1;
    return new Uint8Array(byteLength).fill(counter);
  };
}

describe("createBridgeChannel", () => {
  it("mints a base64url nonce with no padding", () => {
    const channel = createBridgeChannel(1_000, countingRandom());

    expect(channel.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(channel.nonce).not.toContain("=");
    expect(channel.handshake).toBeNull();
    expect(channel.seenMessageIds.size).toBe(0);
  });

  it("uses the full nonce width", () => {
    const requested: number[] = [];
    createBridgeChannel(1_000, (byteLength) => {
      requested.push(byteLength);
      return new Uint8Array(byteLength);
    });

    expect(requested).toEqual([CHANNEL_NONCE_BYTES]);
  });

  it("refuses a randomness source that returns the wrong length", () => {
    expect(() => createBridgeChannel(1_000, () => new Uint8Array(4))).toThrow(/wrong length/);
  });

  it("produces different nonces for different randomness", () => {
    const random = countingRandom();

    expect(createBridgeChannel(1, random).nonce).not.toBe(createBridgeChannel(2, random).nonce);
  });

  it("uses real randomness by default", () => {
    const first = createBridgeChannel(1_000, defaultRandomSource);
    const second = createBridgeChannel(1_000, defaultRandomSource);

    expect(first.nonce).not.toBe(second.nonce);
  });

  it("fails loudly rather than falling back when randomness is unavailable", () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      expect(() => defaultRandomSource(8)).toThrow(/getRandomValues/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});

describe("ChannelRegistry", () => {
  it("has no channel before a document loads", () => {
    const registry = new ChannelRegistry(countingRandom());

    expect(registry.current()).toBeNull();
    expect(registry.isCurrent("anything")).toBe(false);
    expect(registry.handshake()).toBeNull();
  });

  it("replaces the nonce on every document load", () => {
    const registry = new ChannelRegistry(countingRandom());
    const first = registry.beginDocumentLoad(1_000);

    const second = registry.beginDocumentLoad(2_000);

    expect(second.nonce).not.toBe(first.nonce);
    expect(registry.isCurrent(first.nonce)).toBe(false);
    expect(registry.isCurrent(second.nonce)).toBe(true);
  });

  it("drops handshake and dedupe state on reload", () => {
    const registry = new ChannelRegistry(countingRandom());
    const first = registry.beginDocumentLoad(1_000);
    registry.completeHandshake(first.nonce, { webBuildId: "build-a", protocolVersion: 1 });
    registry.rememberMessage(first.nonce, "m1");

    registry.beginDocumentLoad(2_000);

    expect(registry.handshake()).toBeNull();
    // The same message ID is new again, because it belongs to a new document.
    expect(registry.rememberMessage(registry.current()?.nonce ?? "", "m1")).toBe(true);
  });

  it("keeps the channel when no document load occurs", () => {
    const registry = new ChannelRegistry(countingRandom());
    const channel = registry.beginDocumentLoad(1_000);
    registry.completeHandshake(channel.nonce, { webBuildId: "build-a", protocolVersion: 1 });

    // An in-document history navigation never reaches `beginDocumentLoad`, so
    // the page keeps talking on the channel it already negotiated.
    expect(registry.handshake()).toEqual({ webBuildId: "build-a", protocolVersion: 1 });
    expect(registry.isCurrent(channel.nonce)).toBe(true);
  });

  it("invalidates the channel outright", () => {
    const registry = new ChannelRegistry(countingRandom());
    const channel = registry.beginDocumentLoad(1_000);

    registry.invalidate();

    expect(registry.current()).toBeNull();
    expect(registry.isCurrent(channel.nonce)).toBe(false);
    expect(registry.rememberMessage(channel.nonce, "m1")).toBe(false);
  });

  it("refuses a handshake for a stale nonce", () => {
    const registry = new ChannelRegistry(countingRandom());
    const stale = registry.beginDocumentLoad(1_000);
    registry.beginDocumentLoad(2_000);

    expect(registry.completeHandshake(stale.nonce, { webBuildId: "b", protocolVersion: 1 })).toBe(
      false,
    );
    expect(registry.handshake()).toBeNull();
  });

  it("refuses a second handshake on the same document", () => {
    const registry = new ChannelRegistry(countingRandom());
    const channel = registry.beginDocumentLoad(1_000);
    registry.completeHandshake(channel.nonce, { webBuildId: "first", protocolVersion: 1 });

    const again = registry.completeHandshake(channel.nonce, {
      webBuildId: "second",
      protocolVersion: 1,
    });

    expect(again).toBe(false);
    expect(registry.handshake()?.webBuildId).toBe("first");
  });

  it("rejects a repeated message id", () => {
    const registry = new ChannelRegistry(countingRandom());
    const channel = registry.beginDocumentLoad(1_000);

    expect(registry.rememberMessage(channel.nonce, "m1")).toBe(true);
    expect(registry.rememberMessage(channel.nonce, "m1")).toBe(false);
  });

  it("bounds the dedupe set by evicting the oldest ids", () => {
    const registry = new ChannelRegistry(countingRandom());
    const channel = registry.beginDocumentLoad(1_000);
    for (let index = 0; index < MAX_SEEN_MESSAGE_IDS; index += 1) {
      registry.rememberMessage(channel.nonce, `m${index}`);
    }

    registry.rememberMessage(channel.nonce, "overflow");

    expect(channel.seenMessageIds.size).toBe(MAX_SEEN_MESSAGE_IDS);
    expect(channel.seenMessageIds.has("m0")).toBe(false);
    expect(channel.seenMessageIds.has("overflow")).toBe(true);
  });
});
