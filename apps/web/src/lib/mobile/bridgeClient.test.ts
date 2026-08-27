import { MOBILE_PROTOCOL_MAX } from "@openmapx/core/navigation";
import { describe, expect, it } from "vitest";
import {
  BridgeClient,
  BridgeError,
  MAX_PENDING,
  PREPARE_TIMEOUT_MS,
  READ_TIMEOUT_MS,
} from "./bridgeClient";
import { CHANNEL_GLOBAL } from "./mobileShellEnvironment";
import { NativeNavigationCommands } from "./navigationCommands";

const NONCE = "nonce-abc";

/** A scope that behaves like a document inside the shell. */
function shellScope() {
  const sent: string[] = [];
  const handlers = new Map<string, (event: Event) => void>();

  const scope = {
    [CHANNEL_GLOBAL]: { nonce: NONCE },
    ReactNativeWebView: {
      postMessage: (message: string) => sent.push(message),
    },
    addEventListener: (type: string, handler: (event: Event) => void) => {
      handlers.set(type, handler);
    },
    removeEventListener: (type: string) => {
      handlers.delete(type);
    },
  };

  /** Delivers a native-to-web message the way the shell's injected script does. */
  const deliver = (payload: unknown) => {
    handlers.get("openmapx:native")?.({ detail: payload } as unknown as Event);
  };

  return { scope, sent, deliver, handlerCount: () => handlers.size };
}

interface Timer {
  callback: () => void;
  dueAtMs: number;
}

function harness(options: { scope?: unknown } = {}) {
  const shell = shellScope();
  const timers = new Map<number, Timer>();
  let nextHandle = 1;
  let now = 1_700_000_000_000;

  const client = new BridgeClient({
    webBuildId: "web-build-1",
    scope: options.scope ?? shell.scope,
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, dueAtMs: now + delayMs });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  });

  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.dueAtMs <= now) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };

  return { client, ...shell, advance, timerCount: () => timers.size };
}

function helloReply(forMessageId: string, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type: "native.hello",
    messageId: "n1",
    channelNonce: NONCE,
    sentAtMs: 1_700_000_000_000,
    payload: {
      shellVersion: "1.0.0",
      shellBuild: "1",
      selectedProtocolVersion: MOBILE_PROTOCOL_MAX,
      minProtocolVersion: MOBILE_PROTOCOL_MAX,
      maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      platform: "ios",
      capabilities: {
        groundNavigation: true,
        transitNavigation: true,
        backgroundLocation: true,
        localNotifications: true,
        speech: true,
      },
      permission: "background",
      locationDriver: "expo",
      activeSession: null,
      forMessageId,
      ...overrides,
    },
  };
}

function deliverHello(
  context: ReturnType<typeof harness>,
  overrides: Record<string, unknown> = {},
) {
  const forMessageId = JSON.parse(context.sent[0]).messageId as string;
  context.deliver(helloReply(forMessageId, overrides));
}

function snapshotMessage(revision: number) {
  return {
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type: "snapshot.update",
    messageId: `n-snap-${revision}`,
    channelNonce: NONCE,
    sentAtMs: 1_700_000_000_000,
    payload: { snapshot: { revision } },
  };
}

describe("BridgeClient.attach", () => {
  it("attaches inside the shell", () => {
    const { client } = harness();

    expect(client.attach()).toBe(true);
    expect(client.isAvailable).toBe(true);
  });

  it("does not attach in an ordinary browser", () => {
    const { client } = harness({ scope: {} });

    expect(client.attach()).toBe(false);
    expect(client.isAvailable).toBe(false);
  });

  it("refuses a descriptor with no transport rather than pretending to be a browser", () => {
    // A shell whose transport is missing is broken, not absent — and the caller
    // must not fall back to browser navigation inside an installed binary.
    const { client } = harness({ scope: { [CHANNEL_GLOBAL]: { nonce: NONCE } } });

    expect(client.attach()).toBe(false);
  });

  it("removes its listener when closed", () => {
    const context = harness();
    context.client.attach();

    context.client.close();

    expect(context.handlerCount()).toBe(0);
  });
});

describe("BridgeClient.hello", () => {
  it("negotiates and reports what the shell can do", async () => {
    const context = harness();
    context.client.attach();

    const pending = context.client.hello();
    deliverHello(context);
    const result = await pending;

    expect(result.selectedProtocolVersion).toBe(MOBILE_PROTOCOL_MAX);
    expect(result.capabilities.groundNavigation).toBe(true);
    expect(context.client.negotiated).toBe(result);
  });

  it("sends the web build id so the shell knows which page it is talking to", async () => {
    const context = harness();
    context.client.attach();

    const pending = context.client.hello();
    deliverHello(context);
    await pending;

    expect(JSON.parse(context.sent[0]).payload.webBuildId).toBe("web-build-1");
  });

  it("stamps the channel nonce of this document", async () => {
    const context = harness();
    context.client.attach();

    const pending = context.client.hello();
    deliverHello(context);
    await pending;

    expect(JSON.parse(context.sent[0]).channelNonce).toBe(NONCE);
  });

  it("times out rather than waiting forever for a shell that never answers", async () => {
    const context = harness();
    context.client.attach();

    const pending = context.client.hello();
    context.advance(PREPARE_TIMEOUT_MS);

    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("BridgeClient.request", () => {
  async function negotiated() {
    const context = harness();
    context.client.attach();
    const pending = context.client.hello();
    deliverHello(context);
    await pending;
    context.sent.length = 0;
    return context;
  }

  it("refuses a command before negotiation", async () => {
    const context = harness();
    context.client.attach();

    await expect(context.client.request("snapshot.request", {})).rejects.toMatchObject({
      code: "not-negotiated",
    });
  });

  it("refuses a command when the shell is incompatible", async () => {
    const context = harness();
    context.client.attach();
    const pending = context.client.hello();
    deliverHello(context, { selectedProtocolVersion: null });
    await pending;

    await expect(context.client.request("snapshot.request", {})).rejects.toMatchObject({
      code: "incompatible",
    });
  });

  it("refuses a command with no transport at all", async () => {
    const context = harness({ scope: {} });

    await expect(context.client.request("snapshot.request", {})).rejects.toMatchObject({
      code: "no-transport",
    });
  });

  it("refuses a malformed command locally rather than sending it", async () => {
    const context = await negotiated();

    await expect(
      context.client.request("session.prepare", { nonsense: true }),
    ).rejects.toMatchObject({ code: "invalid-command" });
    expect(context.sent).toEqual([]);
  });

  it("resolves with the reply that answers it", async () => {
    const context = await negotiated();

    const pending = context.client.request("session.stop", {}, { sessionId: "s1" });
    const forMessageId = JSON.parse(context.sent[0]).messageId as string;
    context.deliver({
      protocolVersion: MOBILE_PROTOCOL_MAX,
      type: "session.stopped",
      messageId: "n2",
      channelNonce: NONCE,
      sentAtMs: 1_700_000_000_000,
      payload: { sessionId: "s1", finalStatus: "stopped", revision: 4, forMessageId },
    });

    await expect(pending).resolves.toMatchObject({ type: "session.stopped" });
  });

  it("matches an error to the command that named it", async () => {
    const context = await negotiated();

    const pending = context.client.request("session.stop", {}, { sessionId: "s1" });
    const messageId = JSON.parse(context.sent[0]).messageId;
    context.deliver({
      protocolVersion: MOBILE_PROTOCOL_MAX,
      type: "native.error",
      messageId: "n3",
      channelNonce: NONCE,
      sentAtMs: 1_700_000_000_000,
      payload: { code: "revision-conflict", forMessageId: messageId },
    });

    await expect(pending).resolves.toMatchObject({ type: "native.error" });
  });

  it("matches concurrent replies by request id even when they arrive out of order", async () => {
    const context = await negotiated();

    const first = context.client.request("snapshot.request", {});
    const second = context.client.request("snapshot.request", {});
    const firstMessageId = JSON.parse(context.sent[0]).messageId as string;
    const secondMessageId = JSON.parse(context.sent[1]).messageId as string;

    context.deliver({
      ...snapshotMessage(2),
      protocolVersion: MOBILE_PROTOCOL_MAX,
      payload: { snapshot: { revision: 2 }, forMessageId: secondMessageId },
    });

    expect(context.client.pendingCount).toBe(1);
    await expect(second).resolves.toMatchObject({ payload: { snapshot: { revision: 2 } } });

    context.deliver({
      ...snapshotMessage(1),
      protocolVersion: MOBILE_PROTOCOL_MAX,
      payload: { snapshot: { revision: 1 }, forMessageId: firstMessageId },
    });

    await expect(first).resolves.toMatchObject({ payload: { snapshot: { revision: 1 } } });
    expect(context.client.pendingCount).toBe(0);
  });

  it("delivers a correlated snapshot reply to state subscribers", async () => {
    const context = await negotiated();
    const seen: unknown[] = [];
    context.client.subscribe((message) => seen.push(message));

    const pending = context.client.request("snapshot.request", {});
    const messageId = JSON.parse(context.sent[0]).messageId as string;
    context.deliver({
      ...snapshotMessage(7),
      protocolVersion: MOBILE_PROTOCOL_MAX,
      payload: { snapshot: { revision: 7 }, forMessageId: messageId },
    });

    await expect(pending).resolves.toMatchObject({ type: "snapshot.update" });
    expect(seen).toEqual([
      expect.objectContaining({
        type: "snapshot.update",
        payload: expect.objectContaining({ snapshot: { revision: 7 } }),
      }),
    ]);
  });

  it("rejects a correlated reply whose type cannot answer the named command", async () => {
    const context = await negotiated();
    const pending = context.client.request("snapshot.request", {});
    const messageId = JSON.parse(context.sent[0]).messageId as string;

    context.deliver({
      protocolVersion: MOBILE_PROTOCOL_MAX,
      type: "location.result",
      messageId: "wrong-reply-type",
      channelNonce: NONCE,
      sentAtMs: 1_700_000_000_000,
      payload: {
        requestId: "location-1",
        status: "timeout",
        forMessageId: messageId,
      },
    });

    await expect(pending).rejects.toMatchObject({ code: "invalid-response" });
    expect(context.client.pendingCount).toBe(0);
  });

  it("does not retain a pending request for a fire-and-forget event acknowledgement", async () => {
    const context = await negotiated();
    const commands = new NativeNavigationCommands(context.client, () => ({
      sessionId: "s1",
      revision: 1,
    }));

    const acknowledgement = commands.acknowledgeEvents(["event-1"]);
    await Promise.resolve();

    expect(context.client.pendingCount).toBe(0);
    expect(JSON.parse(context.sent[0])).toMatchObject({
      type: "event.ack",
      payload: { eventIds: ["event-1"] },
    });
    await acknowledgement;
  });

  it("times out a read-only command on the short deadline", async () => {
    const context = await negotiated();

    const pending = context.client.request("snapshot.request", {});
    context.advance(READ_TIMEOUT_MS);

    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });

  it("leaves no timer behind once a reply arrives", async () => {
    const context = await negotiated();

    const pending = context.client.request("session.stop", {}, { sessionId: "s1" });
    const forMessageId = JSON.parse(context.sent[0]).messageId as string;
    context.deliver({
      protocolVersion: MOBILE_PROTOCOL_MAX,
      type: "session.stopped",
      messageId: "n4",
      channelNonce: NONCE,
      sentAtMs: 1_700_000_000_000,
      payload: { sessionId: "s1", finalStatus: "stopped", revision: 1, forMessageId },
    });
    await pending;

    expect(context.timerCount()).toBe(0);
    expect(context.client.pendingCount).toBe(0);
  });

  it("refuses new work once too many requests are outstanding", async () => {
    const context = await negotiated();
    const pendings: Promise<unknown>[] = [];
    for (let index = 0; index < MAX_PENDING; index += 1) {
      pendings.push(context.client.request("snapshot.request", {}).catch(() => undefined));
    }

    await expect(context.client.request("snapshot.request", {})).rejects.toMatchObject({
      code: "too-many-pending",
    });

    context.client.close();
    await Promise.all(pendings);
  });

  it("abandons everything pending when the document goes away", async () => {
    // A promise that never settles is a spinner the user cannot escape.
    const context = await negotiated();
    const pending = context.client.request("snapshot.request", {});

    context.client.close();

    await expect(pending).rejects.toMatchObject({ code: "channel-reset" });
  });

  it("refuses new work after closing", async () => {
    const context = await negotiated();
    context.client.close();

    await expect(context.client.request("snapshot.request", {})).rejects.toMatchObject({
      code: "channel-reset",
    });
  });
});

describe("BridgeClient inbound messages", () => {
  async function negotiated() {
    const context = harness();
    context.client.attach();
    const pending = context.client.hello();
    deliverHello(context);
    await pending;
    return context;
  }

  it("delivers an unsolicited snapshot to subscribers", async () => {
    const context = await negotiated();
    const seen: unknown[] = [];
    context.client.subscribe((message) => seen.push(message));

    context.deliver(snapshotMessage(7));

    expect(seen).toHaveLength(1);
  });

  it("ignores a message for a document that no longer exists", async () => {
    // The shell rotates the nonce per load.
    const context = await negotiated();
    const seen: unknown[] = [];
    context.client.subscribe((message) => seen.push(message));

    context.deliver({ ...snapshotMessage(7), channelNonce: "some-other-document" });

    expect(seen).toEqual([]);
  });

  it("ignores a message that does not match the protocol", async () => {
    const context = await negotiated();
    const seen: unknown[] = [];
    context.client.subscribe((message) => seen.push(message));

    context.deliver({ type: "snapshot.update", payload: { snapshot: {} } });
    context.deliver("not an object");
    context.deliver(null);

    expect(seen).toEqual([]);
  });

  it("stops delivering once unsubscribed", async () => {
    const context = await negotiated();
    const seen: unknown[] = [];
    const unsubscribe = context.client.subscribe((message) => seen.push(message));

    unsubscribe();
    context.deliver(snapshotMessage(7));

    expect(seen).toEqual([]);
  });
});

describe("BridgeError", () => {
  it("carries a stable code a caller can branch on", () => {
    const error = new BridgeError("timeout");

    expect(error.code).toBe("timeout");
    expect(error.name).toBe("BridgeError");
  });
});
