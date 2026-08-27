import {
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  type WebToNativeMessage,
} from "@openmapx/core/navigation";
import { ChannelRegistry } from "./channel";
import { NativeBridge, type ShellDescription } from "./nativeBridge";

/**
 * The current native binary against web apps it may meet.
 *
 * The web app deploys continuously and the store binary does not, so a shipped
 * shell will spend its whole life talking to pages it was not built alongside —
 * a newer one after a deploy. Every pairing has to either work or fail honestly.
 *
 * "Fail honestly" is the load-bearing half. A shell that quietly accepted a
 * message it did not understand, or that let a page believe navigation had
 * started when it had not, is worse than one that refuses.
 */

const WEB_ORIGIN = "https://openmapx.com";
const NOW = 1_700_000_000_000;

const SHELL: ShellDescription = {
  shellVersion: "1.0.0",
  shellBuild: "1",
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
};

function harness() {
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
    dispatch: async (message) => {
      dispatched.push(message);
    },
    describeShell: () => SHELL,
  });

  return { registry, bridge, injected, dispatched };
}

function envelope(
  nonce: string,
  type: string,
  payload: unknown,
  protocolVersion: number,
  messageId: string,
): string {
  return JSON.stringify({
    protocolVersion,
    type,
    messageId,
    channelNonce: nonce,
    sentAtMs: NOW,
    payload,
  });
}

/** Loads a document and completes a handshake for a web app of the given range. */
async function handshaken(webRange: { min: number; max: number }) {
  const h = harness();
  const nonce = h.registry.beginDocumentLoad(NOW).nonce;
  await h.bridge.receive({
    url: `${WEB_ORIGIN}/`,
    data: envelope(
      nonce,
      "web.hello",
      {
        webBuildId: "web-build-1",
        minProtocolVersion: webRange.min,
        maxProtocolVersion: webRange.max,
      },
      webRange.max,
      "hello-1",
    ),
  });
  return { ...h, nonce };
}

/**
 * The `native.hello` the shell injected in reply.
 *
 * Outbound messages are base64 inside a small decoder program, so reading one
 * back means undoing exactly that — matching on the raw script text would pass
 * or fail on the encoder's formatting rather than on the message.
 */
function helloPayload(injected: string[]): Record<string, unknown> | null {
  for (const script of injected) {
    const encoded = script.match(/atob\("([A-Za-z0-9+/=]*)"\)/)?.[1];
    if (!encoded) continue;
    const message = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      type?: string;
      payload?: Record<string, unknown>;
    };
    if (message.type === "native.hello" && message.payload) return message.payload;
  }
  return null;
}

describe("current native against a current web app", () => {
  it("negotiates the highest version both have", async () => {
    const { injected } = await handshaken({ min: MOBILE_PROTOCOL_MIN, max: MOBILE_PROTOCOL_MAX });

    expect(helloPayload(injected)?.selectedProtocolVersion).toBe(MOBILE_PROTOCOL_MAX);
  });

  it("accepts the current vocabulary", async () => {
    const { bridge, dispatched, nonce } = await handshaken({
      min: MOBILE_PROTOCOL_MIN,
      max: MOBILE_PROTOCOL_MAX,
    });

    const outcome = await bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: envelope(
        nonce,
        "location.request",
        { requestId: "r1", accuracy: "precise", timeoutMs: 10_000, maxAgeMs: 0 },
        MOBILE_PROTOCOL_MAX,
        "m-3",
      ),
    });

    expect(outcome).toEqual({ status: "handled", type: "location.request" });
    expect(dispatched).toHaveLength(1);
  });
});

describe("current native against a web app it cannot meet", () => {
  it("reports no negotiated version rather than guessing", async () => {
    const { injected } = await handshaken({
      min: MOBILE_PROTOCOL_MAX + 1,
      max: MOBILE_PROTOCOL_MAX + 2,
    });

    // The page has to say "update required" and start nothing.
    expect(helloPayload(injected)?.selectedProtocolVersion).toBeNull();
  });

  it("dispatches no command afterwards", async () => {
    const { bridge, dispatched, nonce } = await handshaken({
      min: MOBILE_PROTOCOL_MAX + 1,
      max: MOBILE_PROTOCOL_MAX + 2,
    });

    await bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: envelope(nonce, "snapshot.request", {}, MOBILE_PROTOCOL_MAX + 1, "m-4"),
    });

    expect(dispatched).toEqual([]);
  });
});

describe("a malformed hello", () => {
  it("leaves the channel unhandshaken rather than half-open", async () => {
    const h = harness();
    const nonce = h.registry.beginDocumentLoad(NOW).nonce;

    await h.bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: envelope(
        nonce,
        "web.hello",
        { webBuildId: "web-build-1" },
        MOBILE_PROTOCOL_MAX,
        "hello-bad",
      ),
    });
    const outcome = await h.bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: envelope(nonce, "snapshot.request", {}, MOBILE_PROTOCOL_MAX, "m-5"),
    });

    expect(outcome).toEqual({ status: "rejected", code: "handshake-required" });
  });
});

describe("a web reload mid-session", () => {
  it("requires a fresh handshake on the new document", async () => {
    const { bridge, registry, nonce } = await handshaken({
      min: MOBILE_PROTOCOL_MIN,
      max: MOBILE_PROTOCOL_MAX,
    });

    // The reload rotates the nonce, so the old document's channel is gone.
    const nextNonce = registry.beginDocumentLoad(NOW + 1).nonce;
    expect(nextNonce).not.toBe(nonce);

    const outcome = await bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: envelope(nextNonce, "snapshot.request", {}, MOBILE_PROTOCOL_MAX, "m-6"),
    });

    expect(outcome).toEqual({ status: "rejected", code: "handshake-required" });
  });

  it("refuses a command replayed with the previous document's nonce", async () => {
    const { bridge, registry, nonce } = await handshaken({
      min: MOBILE_PROTOCOL_MIN,
      max: MOBILE_PROTOCOL_MAX,
    });
    registry.beginDocumentLoad(NOW + 1);

    const outcome = await bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: envelope(nonce, "snapshot.request", {}, MOBILE_PROTOCOL_MAX, "m-7"),
    });

    // A page that no longer exists cannot be issuing commands.
    expect(outcome).toEqual({ status: "rejected", code: "wrong-channel" });
  });
});

describe("a web deployment changing build id mid-session", () => {
  it("renegotiates cleanly on the next load", async () => {
    const { bridge, registry, injected } = await handshaken({
      min: MOBILE_PROTOCOL_MIN,
      max: MOBILE_PROTOCOL_MAX,
    });
    const before = injected.length;

    const nextNonce = registry.beginDocumentLoad(NOW + 1).nonce;
    await bridge.receive({
      url: `${WEB_ORIGIN}/`,
      data: envelope(
        nextNonce,
        "web.hello",
        {
          webBuildId: "web-build-2",
          minProtocolVersion: MOBILE_PROTOCOL_MIN,
          maxProtocolVersion: MOBILE_PROTOCOL_MAX,
        },
        MOBILE_PROTOCOL_MAX,
        "hello-2",
      ),
    });

    // A new build is a new conversation, not a mismatch to report.
    expect(injected.length).toBeGreaterThan(before);
    expect(helloPayload(injected)?.selectedProtocolVersion).toBe(MOBILE_PROTOCOL_MAX);
  });
});
