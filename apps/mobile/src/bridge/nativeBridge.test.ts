import {
  MAX_MESSAGE_BYTES,
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  type WebToNativeMessage,
} from "@openmapx/core/navigation";
import { ChannelRegistry } from "./channel";
import {
  MAX_QUEUED_OUTBOUND,
  NativeBridge,
  type ReceiveOutcome,
  type ShellDescription,
} from "./nativeBridge";

const WEB_ORIGIN = "https://openmapx.com";
/** The least a progress snapshot must carry for the page to place it. */
function progressSnapshot(revision: number) {
  return { type: "progress", sessionId: "s1", revision, routeFingerprint: "2:abc" } as const;
}

const NOW = 1_700_000_000_000;

const SHELL: ShellDescription = {
  shellVersion: "1.0.0",
  shellBuild: "1",
  platform: "ios",
  capabilities: {
    groundNavigation: false,
    transitNavigation: false,
    backgroundLocation: true,
    localNotifications: true,
    speech: true,
  },
  permission: "not-determined",
  locationDriver: "expo",
  activeSession: null,
};

function harness(
  overrides: Partial<
    Pick<
      ConstructorParameters<typeof NativeBridge>[0],
      "dispatch" | "describeShell" | "reportInvalid"
    >
  > = {},
) {
  // Deterministic but distinct per load, so a stale nonce is genuinely stale.
  let nonceSeed = 0;
  const registry = new ChannelRegistry((byteLength) => {
    nonceSeed += 1;
    return new Uint8Array(byteLength).fill(nonceSeed);
  });
  const injected: string[] = [];
  const dispatched: WebToNativeMessage[] = [];
  let messageCounter = 0;

  const bridge = new NativeBridge({
    webOrigin: WEB_ORIGIN,
    registry,
    now: () => NOW,
    nextMessageId: () => {
      messageCounter += 1;
      return `native-${messageCounter}`;
    },
    inject: (script) => injected.push(script),
    dispatch:
      overrides.dispatch ??
      (async (message) => {
        dispatched.push(message);
      }),
    describeShell: overrides.describeShell ?? (() => SHELL),
    ...(overrides.reportInvalid ? { reportInvalid: overrides.reportInvalid } : {}),
  });

  return { registry, bridge, injected, dispatched };
}

interface CommandOverrides {
  type?: string;
  messageId?: string;
  channelNonce?: string;
  protocolVersion?: number;
  sentAtMs?: number;
  payload?: unknown;
  sessionId?: string;
  revision?: number;
}

function command(nonce: string, overrides: CommandOverrides = {}): string {
  return JSON.stringify({
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type: "snapshot.request",
    messageId: "m1",
    channelNonce: nonce,
    sentAtMs: NOW,
    payload: {},
    ...overrides,
  });
}

function hello(
  nonce: string,
  range = { min: MOBILE_PROTOCOL_MIN, max: MOBILE_PROTOCOL_MAX },
): string {
  return command(nonce, {
    type: "web.hello",
    messageId: "hello-1",
    payload: {
      webBuildId: "web-build-1",
      minProtocolVersion: range.min,
      maxProtocolVersion: range.max,
    },
  });
}

/** Loads a document and completes the handshake, the usual starting state. */
async function handshaken() {
  const context = harness();
  const channel = context.registry.beginDocumentLoad(NOW);
  await context.bridge.receive({ url: `${WEB_ORIGIN}/`, data: hello(channel.nonce) });
  return { ...context, nonce: channel.nonce };
}

function rejection(outcome: ReceiveOutcome): string {
  return outcome.status === "rejected" ? outcome.code : `handled:${outcome.type}`;
}

describe("NativeBridge.receive", () => {
  describe("origin", () => {
    const cases: Array<[string, string]> = [
      ["a subdomain", "https://maps.openmapx.com/"],
      ["a lookalike host", "https://openmapx.com.evil.example/"],
      ["a suffix host", "https://evilopenmapx.com/"],
      ["a different port", "https://openmapx.com:8443/"],
      ["a downgraded scheme", "http://openmapx.com/"],
      ["embedded credentials", "https://user:pass@openmapx.com/"],
      ["a blob document", "blob:https://openmapx.com/9c1f"],
      ["a data document", "data:text/html,<script></script>"],
      ["a file document", "file:///android_asset/index.html"],
      ["an about document", "about:blank"],
    ];

    it.each(cases)("rejects %s", async (_label, url) => {
      const { bridge, registry, dispatched } = harness();
      const channel = registry.beginDocumentLoad(NOW);

      const outcome = await bridge.receive({ url, data: command(channel.nonce) });

      expect(rejection(outcome)).toBe("wrong-origin");
      expect(dispatched).toEqual([]);
    });

    it("rejects a message with no reporting URL at all", async () => {
      const { bridge, registry, dispatched } = harness();
      const channel = registry.beginDocumentLoad(NOW);

      const outcome = await bridge.receive({ data: command(channel.nonce) });

      expect(rejection(outcome)).toBe("wrong-origin");
      expect(dispatched).toEqual([]);
    });

    it("accepts a path and query under the exact origin", async () => {
      const { bridge, dispatched, nonce } = await handshaken();

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/directions?to=1#frag`,
        data: command(nonce, { messageId: "m-path" }),
      });

      expect(rejection(outcome)).toBe("handled:snapshot.request");
      expect(dispatched).toHaveLength(1);
    });
  });

  describe("channel", () => {
    it("rejects everything before a document has loaded", async () => {
      const { bridge, dispatched } = harness();

      const outcome = await bridge.receive({ url: `${WEB_ORIGIN}/`, data: command("whatever") });

      expect(rejection(outcome)).toBe("no-channel");
      expect(dispatched).toEqual([]);
    });

    it("rejects a nonce from a previous document", async () => {
      const { bridge, registry, dispatched } = await handshaken();
      const stale = registry.current()?.nonce ?? "";
      registry.beginDocumentLoad(NOW + 1);

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: command(stale, { messageId: "m-stale" }),
      });

      expect(rejection(outcome)).toBe("wrong-channel");
      expect(dispatched).toEqual([]);
    });

    it("rejects a guessed nonce", async () => {
      const { bridge, dispatched } = await handshaken();

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: command("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ"),
      });

      expect(rejection(outcome)).toBe("wrong-channel");
      expect(dispatched).toEqual([]);
    });

    it("rejects a replayed message id", async () => {
      const { bridge, dispatched, nonce } = await handshaken();
      await bridge.receive({ url: `${WEB_ORIGIN}/`, data: command(nonce, { messageId: "dup" }) });

      const replay = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: command(nonce, { messageId: "dup" }),
      });

      expect(rejection(replay)).toBe("duplicate-message");
      expect(dispatched).toHaveLength(1);
    });

    it("requires a fresh handshake after a reload", async () => {
      const { bridge, registry, dispatched } = await handshaken();
      const reloaded = registry.beginDocumentLoad(NOW + 1);

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: command(reloaded.nonce, { messageId: "after-reload" }),
      });

      expect(rejection(outcome)).toBe("handshake-required");
      expect(dispatched).toEqual([]);
    });
  });

  describe("protocol", () => {
    it("contains a rejecting shell description without completing the handshake", async () => {
      const context = harness({
        describeShell: async () => {
          throw new Error("secret provider response");
        },
      });
      const channel = context.registry.beginDocumentLoad(NOW);

      const outcome = await context.bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: hello(channel.nonce),
      });

      expect(outcome).toEqual({ status: "failed", code: "internal-error", type: "web.hello" });
      expect(context.registry.handshake()).toBeNull();
      expect(decodePayload(context.injected[0])).toMatchObject({
        type: "native.error",
        payload: { code: "internal-error", forMessageId: "hello-1" },
      });
      expect(context.injected.join("\n")).not.toContain("secret provider response");
    });

    it("discards a shell description that resolves after the document changed", async () => {
      let resolveDescription: ((shell: ShellDescription) => void) | undefined;
      const context = harness({
        describeShell: () =>
          new Promise<ShellDescription>((resolve) => {
            resolveDescription = resolve;
          }),
      });
      const first = context.registry.beginDocumentLoad(NOW);
      const receiving = context.bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: hello(first.nonce),
      });
      context.registry.beginDocumentLoad(NOW + 1);

      resolveDescription?.(SHELL);

      await expect(receiving).resolves.toEqual({ status: "rejected", code: "wrong-channel" });
      expect(context.registry.handshake()).toBeNull();
      expect(context.injected).toEqual([]);
    });

    it("rejects a command sent before the handshake", async () => {
      const { bridge, registry, dispatched } = harness();
      const channel = registry.beginDocumentLoad(NOW);

      const outcome = await bridge.receive({ url: `${WEB_ORIGIN}/`, data: command(channel.nonce) });

      expect(rejection(outcome)).toBe("handshake-required");
      expect(dispatched).toEqual([]);
    });

    it("answers an incompatible range without selecting a version", async () => {
      const { bridge, registry, injected, dispatched } = harness();
      const channel = registry.beginDocumentLoad(NOW);

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: hello(channel.nonce, { min: 9, max: 12 }),
      });

      expect(rejection(outcome)).toBe("handled:web.hello");
      expect(registry.handshake()).toBeNull();
      // The page still learns a shell exists, so it can ask for an update.
      expect(injected).toHaveLength(1);
      expect(decodePayload(injected[0]).payload.selectedProtocolVersion).toBeNull();
      const refused = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: command(channel.nonce, { messageId: "after-fail" }),
      });
      expect(rejection(refused)).toBe("handshake-required");
      expect(dispatched).toEqual([]);
    });

    it("rejects a command whose version differs from the negotiated one", async () => {
      const { bridge, dispatched, nonce } = await handshaken();

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        // One below whatever was negotiated: still a real version, still not
        // the one this channel agreed on.
        data: command(nonce, { messageId: "m-version", protocolVersion: MOBILE_PROTOCOL_MAX - 1 }),
      });

      expect(rejection(outcome)).toBe("protocol-mismatch");
      expect(dispatched).toEqual([]);
    });
  });

  it("contains a rejecting authenticated dispatcher and emits one redacted correlated error", async () => {
    const context = harness({
      dispatch: async () => {
        throw new Error("secret database detail");
      },
    });
    const channel = context.registry.beginDocumentLoad(NOW);
    await context.bridge.receive({ url: `${WEB_ORIGIN}/`, data: hello(channel.nonce) });

    const outcome = await context.bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: command(channel.nonce, { messageId: "rejecting-command" }),
    });

    expect(outcome).toEqual({
      status: "failed",
      code: "internal-error",
      type: "snapshot.request",
    });
    expect(decodePayload(context.injected[1])).toMatchObject({
      type: "native.error",
      payload: { code: "internal-error", forMessageId: "rejecting-command" },
    });
    expect(context.injected.join("\n")).not.toContain("secret database detail");
  });

  describe("payload", () => {
    it.each([
      ["an unknown type", { type: "session.selfDestruct" }],
      ["a native-to-web type", { type: "snapshot.update", payload: { snapshot: {} } }],
      ["an unexpected extra field", { payload: { extra: true } }],
      ["a missing message id", { messageId: undefined }],
    ])("rejects %s", async (_label, overrides) => {
      const { bridge, dispatched, nonce } = await handshaken();

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: command(nonce, overrides as CommandOverrides),
      });

      expect(outcome.status).toBe("rejected");
      expect(dispatched).toEqual([]);
    });

    it("rejects malformed JSON", async () => {
      const { bridge, dispatched, nonce } = await handshaken();

      const outcome = await bridge.receive({ url: `${WEB_ORIGIN}/`, data: `{"a":` });

      expect(rejection(outcome)).toBe("invalid-json");
      expect(dispatched).toEqual([]);
    });

    it("rejects a prototype-polluting key", async () => {
      const { bridge, dispatched, nonce } = await handshaken();
      const polluted = `{"protocolVersion":${MOBILE_PROTOCOL_MAX},"type":"snapshot.request","messageId":"p","channelNonce":"${nonce}","sentAtMs":${NOW},"payload":{"__proto__":{"polluted":true}}}`;

      const outcome = await bridge.receive({ url: `${WEB_ORIGIN}/`, data: polluted });

      expect(rejection(outcome)).toBe("prototype-pollution");
      expect(dispatched).toEqual([]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("rejects oversize input before parsing it", async () => {
      const { bridge, dispatched, nonce } = await handshaken();

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: "x".repeat(MAX_MESSAGE_BYTES + 1),
      });

      expect(rejection(outcome)).toBe("payload-too-large");
      expect(dispatched).toEqual([]);
    });

    it("rejects a timestamp far from the receiver's clock", async () => {
      const { bridge, dispatched, nonce } = await handshaken();

      const outcome = await bridge.receive({
        url: `${WEB_ORIGIN}/`,
        data: command(nonce, { messageId: "m-skew", sentAtMs: NOW + 60 * 60_000 }),
      });

      expect(rejection(outcome)).toBe("timestamp-out-of-range");
      expect(dispatched).toEqual([]);
    });
  });

  it("forwards the session and revision a command claims, unmodified", async () => {
    const { bridge, dispatched, nonce } = await handshaken();

    await bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: command(nonce, {
        messageId: "m-stop",
        type: "session.stop",
        sessionId: "s1",
        revision: 3,
      }),
    });

    // The bridge is not the authority on staleness — it hands the claim to the
    // coordinator, which compares it against the persisted revision.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].sessionId).toBe("s1");
    expect(dispatched[0].revision).toBe(3);
  });
});

/** Recovers the message a generated script would deliver. */
function decodePayload(script: string): { type: string; payload: Record<string, never> } {
  const match = script.match(/atob\("([^"]*)"\)/);
  if (!match) throw new Error("no payload in script");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

describe("NativeBridge.send", () => {
  it("drops output when no document exists", async () => {
    const { bridge, injected } = harness();

    expect(bridge.send("permission.state", { permission: "denied" })).toBe("dropped");
    expect(injected).toEqual([]);
  });

  it("flushes queued output after the handshake", async () => {
    const { bridge, registry, injected } = harness();
    const channel = registry.beginDocumentLoad(NOW);
    expect(bridge.send("permission.state", { permission: "denied" })).toBe("queued");
    expect(injected).toEqual([]);

    await bridge.receive({ url: `${WEB_ORIGIN}/`, data: hello(channel.nonce) });

    expect(injected).toHaveLength(2);
    expect(decodePayload(injected[0])).toMatchObject({
      type: "native.hello",
      payload: { forMessageId: "hello-1" },
    });
    expect(decodePayload(injected[1]).type).toBe("permission.state");
    expect(bridge.queuedCount).toBe(0);
  });

  it("sends immediately once handshaken", async () => {
    const { bridge, injected, nonce } = await handshaken();

    expect(bridge.send("permission.state", { permission: "background" })).toBe("sent");
    expect(decodePayload(injected[1])).toMatchObject({
      type: "permission.state",
      channelNonce: nonce,
      payload: { permission: "background" },
    });
  });

  it("adds exact correlation to a current direct reply", async () => {
    const { bridge, injected } = await handshaken();

    expect(
      bridge.send(
        "location.result",
        { requestId: "location-1", status: "timeout" },
        { forMessageId: "location-command" },
      ),
    ).toBe("sent");

    expect(decodePayload(injected[1]).payload).toMatchObject({
      requestId: "location-1",
      status: "timeout",
      forMessageId: "location-command",
    });
  });

  it("refuses a payload that does not match the protocol", async () => {
    const { bridge, injected } = await handshaken();

    // @ts-expect-error A payload outside its message's schema does not compile.
    expect(bridge.send("permission.state", { permission: "omniscient" })).toBe("invalid");
    expect(injected).toHaveLength(1);
  });

  it("types each message's payload by its type", async () => {
    const { bridge } = await handshaken();
    const stopped = { sessionId: "s1", finalStatus: "stopped", revision: 1 } as const;

    expect(bridge.send("session.stopped", stopped)).toBe("sent");
    // @ts-expect-error One message's payload is not another's.
    expect(bridge.send("permission.state", stopped)).toBe("invalid");
    // @ts-expect-error A snapshot without its identity does not compile.
    expect(bridge.send("snapshot.update", { snapshot: { revision: 3 } })).toBe("invalid");
  });

  it("reports a refused message by type, without its payload", () => {
    const reported: string[] = [];
    const { bridge, registry } = harness({ reportInvalid: (type) => reported.push(type) });
    registry.beginDocumentLoad(NOW);

    // @ts-expect-error A payload outside its message's schema does not compile.
    expect(bridge.send("permission.state", { permission: "omniscient" })).toBe("invalid");
    expect(reported).toEqual(["permission.state"]);
  });

  it("keeps only the freshest queued snapshot", async () => {
    const { bridge, registry, injected } = harness();
    const channel = registry.beginDocumentLoad(NOW);

    bridge.send("snapshot.update", { snapshot: progressSnapshot(1) });
    bridge.send("snapshot.update", { snapshot: progressSnapshot(2) });
    bridge.send("snapshot.update", { snapshot: progressSnapshot(3) });

    expect(bridge.queuedCount).toBe(1);
    await bridge.receive({ url: WEB_ORIGIN, data: hello(channel.nonce) });
    expect(injected.map(decodePayload)).toMatchObject([
      { type: "native.hello" },
      { type: "snapshot.update", payload: { snapshot: { revision: 3 } } },
    ]);
    expect(bridge.queuedCount).toBe(0);
  });

  it("drops a snapshot rather than a session notice when the queue is full", async () => {
    const { bridge, registry, injected } = harness();
    const channel = registry.beginDocumentLoad(NOW);
    bridge.send("snapshot.update", { snapshot: {} });
    for (let index = 0; index < MAX_QUEUED_OUTBOUND - 1; index += 1) {
      bridge.send("session.stopped", {
        sessionId: `s${index}`,
        finalStatus: "stopped",
        revision: 1,
      });
    }

    expect(
      bridge.send("session.stopped", { sessionId: "last", finalStatus: "stopped", revision: 1 }),
    ).toBe("queued");
    expect(bridge.queuedCount).toBe(MAX_QUEUED_OUTBOUND);
    await bridge.receive({ url: WEB_ORIGIN, data: hello(channel.nonce) });
    const delivered = injected.map(decodePayload).slice(1);
    expect(delivered.every((message) => message.type === "session.stopped")).toBe(true);
    expect(delivered.map((message) => message.payload.sessionId)).toEqual([
      ...Array.from({ length: MAX_QUEUED_OUTBOUND - 1 }, (_, i) => `s${i}`),
      "last",
    ]);
  });

  it("refuses new output when the queue holds nothing droppable", async () => {
    const { bridge, registry, injected } = harness();
    const channel = registry.beginDocumentLoad(NOW);
    for (let index = 0; index < MAX_QUEUED_OUTBOUND; index += 1) {
      bridge.send("session.stopped", {
        sessionId: `s${index}`,
        finalStatus: "stopped",
        revision: 1,
      });
    }

    expect(
      bridge.send("session.stopped", {
        sessionId: "overflow",
        finalStatus: "stopped",
        revision: 1,
      }),
    ).toBe("dropped");
    expect(bridge.queuedCount).toBe(MAX_QUEUED_OUTBOUND);
    await bridge.receive({ url: WEB_ORIGIN, data: hello(channel.nonce) });
    expect(
      injected
        .map(decodePayload)
        .slice(1)
        .map((message) => message.payload.sessionId),
    ).toEqual(Array.from({ length: MAX_QUEUED_OUTBOUND }, (_, i) => `s${i}`));
  });

  it("discards queued output for a document that is gone", async () => {
    const { bridge, registry } = harness();
    registry.beginDocumentLoad(NOW);
    bridge.send("permission.state", { permission: "denied" });

    bridge.discardQueue();

    expect(bridge.queuedCount).toBe(0);
  });
});

describe("intake over the current protocol", () => {
  it("stamps pre-handshake navigation output with the negotiated version", async () => {
    const { bridge, registry, injected } = harness();
    const channel = registry.beginDocumentLoad(NOW);
    expect(bridge.send("snapshot.update", { snapshot: progressSnapshot(1) })).toBe("queued");
    expect(
      bridge.send("session.stopped", {
        sessionId: "before-hello",
        finalStatus: "stopped",
        revision: 1,
      }),
    ).toBe("queued");
    await bridge.receive({ url: WEB_ORIGIN, data: hello(channel.nonce) });
    const messages = injected.map(
      (s) => decodePayload(s) as unknown as { protocolVersion: number; type: string },
    );
    expect(messages.map((m) => m.type)).toEqual([
      "native.hello",
      "snapshot.update",
      "session.stopped",
    ]);
    expect(messages.map((m) => m.protocolVersion)).toEqual([
      MOBILE_PROTOCOL_MAX,
      MOBILE_PROTOCOL_MAX,
      MOBILE_PROTOCOL_MAX,
    ]);
  });

  it("delivers queued intake events after the handshake", async () => {
    const { bridge, registry, injected } = harness();
    const c = registry.beginDocumentLoad(NOW);
    expect(bridge.send("intake.changed", { pendingCount: 1 })).toBe("queued");
    await bridge.receive({ url: WEB_ORIGIN, data: hello(c.nonce) });
    expect(injected.map((s) => decodePayload(s).type)).toEqual(["native.hello", "intake.changed"]);
    expect(bridge.queuedCount).toBe(0);
  });

  it("dispatches intake commands", async () => {
    const { bridge, registry, dispatched } = harness();
    const c = registry.beginDocumentLoad(NOW);
    await bridge.receive({ url: WEB_ORIGIN, data: hello(c.nonce) });
    const result = await bridge.receive({
      url: WEB_ORIGIN,
      data: command(c.nonce, { type: "intake.list" }),
    });
    expect(result).toEqual({ status: "handled", type: "intake.list" });
    expect(dispatched).toHaveLength(1);
  });

  it("advertises intake and car destinations in the hello", async () => {
    const { bridge, registry, injected } = harness({
      describeShell: () => ({
        ...SHELL,
        capabilities: { ...SHELL.capabilities, nativeIntake: true, carDestinations: true },
      }),
    });
    const c = registry.beginDocumentLoad(NOW);
    await bridge.receive({ url: WEB_ORIGIN, data: hello(c.nonce) });
    expect(decodePayload(injected[0]).payload).toMatchObject({
      capabilities: { nativeIntake: true, carDestinations: true },
      selectedProtocolVersion: MOBILE_PROTOCOL_MAX,
    });
  });
});

it("never queues or replays voice events before a document handshake", async () => {
  const f = harness();
  f.registry.beginDocumentLoad(NOW);
  expect(f.bridge.send("voice.event", { requestId: "r", state: "listening" })).toBe("dropped");
  expect(f.bridge.queuedCount).toBe(0);
  const next = f.registry.beginDocumentLoad(NOW);
  await f.bridge.receive({ url: `${WEB_ORIGIN}/`, data: hello(next.nonce) });
  expect(f.injected.join("")).not.toContain("voice.event");
  expect(f.bridge.send("voice.event", { requestId: "s", state: "listening" })).toBe("sent");
  f.registry.invalidate();
  expect(f.bridge.send("voice.event", { requestId: "s", state: "ended" })).toBe("dropped");
  expect(f.bridge.queuedCount).toBe(0);
});
