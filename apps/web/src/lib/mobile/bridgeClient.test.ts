import { MOBILE_PROTOCOL_MAX } from "@openmapx/core/navigation";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_TRANSIT_ITINERARY } from "@/components/panels/directions/TransitRouteView.fixtures";
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

describe("voice dispatch", () => {
  it("correlates availability to the probe, leaving unrelated requests pending", async () => {
    const h = harness();
    h.client.attach();
    const ready = h.client.hello();
    deliverHello(h); // Old APK hello has no voice capability.
    await ready;
    const first = h.client.request("voice.probe", {});
    const firstId = JSON.parse(h.sent.at(-1) ?? "").messageId;
    const second = h.client.request("voice.probe", {});
    const secondId = JSON.parse(h.sent.at(-1) ?? "").messageId;
    const reply = helloReply(firstId);
    h.deliver({
      ...reply,
      type: "voice.availability",
      payload: { forMessageId: secondId, available: false },
    });
    expect((await second).payload).toEqual({ forMessageId: secondId, available: false });
    expect(h.timerCount()).toBe(1);
    h.deliver({
      ...reply,
      type: "voice.availability",
      payload: { forMessageId: firstId, available: true },
    });
    expect((await first).type).toBe("voice.availability");
    expect(h.timerCount()).toBe(0);
  });

  it("times out an unanswered old-APK probe without losing negotiation", async () => {
    const h = harness();
    h.client.attach();
    const ready = h.client.hello();
    deliverHello(h);
    const handshake = await ready;
    const probe = h.client.request("voice.probe", {});
    const rejected = expect(probe).rejects.toMatchObject({ code: "timeout" });
    h.advance(READ_TIMEOUT_MS);
    await rejected;
    expect(h.client.negotiated).toBe(handshake);
  });

  it("validates fire-and-forget commands and broadcasts uncorrelated voice events", async () => {
    const h = harness();
    h.client.attach();
    const ready = h.client.hello();
    deliverHello(h);
    expect((await ready).capabilities).not.toHaveProperty("speechInput");
    const received: unknown[] = [];
    const unsubscribe = h.client.subscribe((event) => received.push(event));
    for (const type of ["voice.start", "voice.stop", "voice.cancel"] as const) {
      h.client.send(type, {
        requestId: "r",
        ...(type === "voice.start" ? { locale: "de-DE" } : {}),
      });
      expect(JSON.parse(h.sent.at(-1) ?? "").type).toBe(type);
    }
    expect(h.client.pendingCount).toBe(0);
    expect(() => h.client.send("voice.start", { requestId: "r", locale: "de_DE" })).toThrow(
      BridgeError,
    );
    const event = {
      ...snapshotMessage(1),
      type: "voice.event",
      payload: { requestId: "r", state: "partial", text: "Berlin" },
    };
    h.deliver({ ...event, channelNonce: "old" });
    h.deliver({ ...event, protocolVersion: MOBILE_PROTOCOL_MAX + 1 });
    h.deliver({ ...event, payload: { ...event.payload, extra: true } });
    expect(received).toEqual([]);
    h.deliver(event);
    expect(received).toEqual([event]);
    unsubscribe();
    h.deliver(event);
    expect(received).toHaveLength(1);
    h.client.close();
  });
});

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

describe("older native protocol negotiation", () => {
  it("accepts version 3 and uses it for subsequent navigation requests", async () => {
    const context = harness();
    context.client.attach();
    const promise = context.client.hello();
    const sent = JSON.parse(context.sent[0]);
    const reply = helloReply(sent.messageId, {
      selectedProtocolVersion: 3,
      minProtocolVersion: 3,
      maxProtocolVersion: 3,
    });
    reply.protocolVersion = 3;
    context.deliver(reply);
    await expect(promise).resolves.toMatchObject({ selectedProtocolVersion: 3 });
    const pending = context.client.request("snapshot.request", {});
    expect(JSON.parse(context.sent[1]).protocolVersion).toBe(3);
    context.client.close();
    await expect(pending).rejects.toBeInstanceOf(BridgeError);
  });
});

it("accepts a null selection using the incompatible native's declared envelope version", async () => {
  const context = harness();
  context.client.attach();
  const pending = context.client.hello();
  const sent = JSON.parse(context.sent[0]);
  const reply = helloReply(sent.messageId, {
    selectedProtocolVersion: null,
    minProtocolVersion: 2,
    maxProtocolVersion: 2,
  });
  reply.protocolVersion = 2;
  context.deliver(reply);
  await expect(pending).resolves.toMatchObject({ selectedProtocolVersion: null });
  context.client.close();
});

it("uses real browser timer defaults for deadlines and cancellation", async () => {
  vi.useFakeTimers();
  const schedule = vi.spyOn(globalThis, "setTimeout");
  const cancel = vi.spyOn(globalThis, "clearTimeout");
  const shell = shellScope();
  const client = new BridgeClient({ webBuildId: "production-timers", scope: shell.scope });
  try {
    client.attach();
    const ready = client.hello();
    const hello = JSON.parse(shell.sent[0]);
    shell.deliver(helloReply(hello.messageId));
    await ready;
    expect(cancel).toHaveBeenCalledTimes(1);
    const timedOut = client.request("intake.list", {}).catch((error: unknown) => error);
    expect(schedule).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(await timedOut).toMatchObject({ code: "timeout" });
    expect(client.pendingCount).toBe(0);
    const cancelled = client.request("intake.list", {}).catch((error: unknown) => error);
    expect(schedule).toHaveBeenCalledTimes(3);
    client.close();
    expect(await cancelled).toMatchObject({ code: "channel-reset" });
    expect(cancel).toHaveBeenCalledTimes(2);
  } finally {
    client.close();
    schedule.mockRestore();
    cancel.mockRestore();
    vi.useRealTimers();
  }
});

describe("navigation Start with production timers", () => {
  it("allows the native permission dialog to outlast the ordinary read deadline", async () => {
    vi.useFakeTimers();
    const shell = shellScope();
    const client = new BridgeClient({ webBuildId: "production", scope: shell.scope });
    client.attach();
    const hello = client.hello();
    shell.deliver(helloReply(JSON.parse(shell.sent[0]).messageId));
    await hello;
    const commands = new NativeNavigationCommands(client, () => ({
      sessionId: null,
      revision: null,
    }));
    let outcome: unknown;
    const pending = commands
      .start({
        kind: "transit",
        itinerary: SAMPLE_TRANSIT_ITINERARY,
        captures: [],
        locale: "en",
        units: "metric",
        itineraryFingerprint: "selected-trip",
        settings: { voiceEnabled: true, keepScreenOn: true, alightAlertsEnabled: true },
      })
      .then(
        (result) => {
          outcome = result;
        },
        (error) => {
          outcome = error;
        },
      );
    try {
      await vi.advanceTimersByTimeAsync(0);
      const preparedFor = JSON.parse(shell.sent.at(-1) ?? "").messageId;
      shell.deliver({
        ...helloReply(preparedFor),
        type: "session.prepared",
        payload: { sessionId: "s1", revision: 1, forMessageId: preparedFor },
      });
      // A person can legitimately spend half a minute granting Android's
      // location permission. That must not make a healthy Start look refused.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(outcome).toBeUndefined();
      const startedFor = JSON.parse(shell.sent.at(-1) ?? "").messageId;
      shell.deliver({
        ...helloReply(startedFor),
        type: "session.started",
        payload: { sessionId: "s1", revision: 2, forMessageId: startedFor },
      });
      await pending;
      expect(outcome).toEqual({ sessionId: "s1", revision: 2 });
      expect(client.pendingCount).toBe(0);
    } finally {
      client.close();
      await pending;
      vi.useRealTimers();
    }
  });
});
