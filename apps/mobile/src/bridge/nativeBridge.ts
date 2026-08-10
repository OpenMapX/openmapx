import {
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  type NativeToWebMessage,
  nativeToWebSchema,
  negotiateMobileProtocol,
  type ParseErrorCode,
  parseMobileBridgeMessage,
  WEB_TO_NATIVE_TYPES,
  type WebToNativeMessage,
} from "@openmapx/core/navigation";
import { classifyNavigation } from "../shell/originPolicy";
import type { ChannelRegistry } from "./channel";
import { buildOutboundScript } from "./outboundScript";

/**
 * The only inbound path from the web document.
 *
 * Every message runs the same gauntlet in the same order — origin, channel,
 * bounds, schema, dedupe, protocol, state — and any failure produces a stable
 * code and no side effect at all. Nothing here interprets a command; that is the
 * coordinator's job, reached only after a message has survived the whole list.
 */

const WEB_TO_NATIVE = new Set<string>(WEB_TO_NATIVE_TYPES);

export type BridgeRejectionCode =
  | ParseErrorCode
  | "wrong-origin"
  | "no-channel"
  | "not-a-command"
  | "duplicate-message"
  | "handshake-required"
  | "protocol-mismatch";

export type ReceiveOutcome =
  | { status: "handled"; type: WebToNativeMessage["type"] }
  | { status: "rejected"; code: BridgeRejectionCode };

export type SendOutcome = "sent" | "queued" | "dropped" | "invalid";

/** Outbound messages held while the page is loading or not yet handshaken. */
export const MAX_QUEUED_OUTBOUND = 256;

export interface ShellDescription {
  shellVersion: string;
  shellBuild: string;
  platform: "ios" | "android";
  capabilities: {
    groundNavigation: boolean;
    transitNavigation: boolean;
    backgroundLocation: boolean;
    localNotifications: boolean;
    speech: boolean;
  };
  permission: "not-determined" | "foreground" | "background" | "denied" | "limited";
  locationDriver: "expo" | "native";
  activeSession: { sessionId: string; revision: number; kind: "ground" | "transit" } | null;
}

export interface NativeBridgeDeps {
  /** The compiled product origin. Nothing else may address the bridge. */
  webOrigin: string;
  registry: ChannelRegistry;
  now: () => number;
  /** Unique per message; the page uses it to correlate a reply to a command. */
  nextMessageId: () => string;
  /** Runs a script inside the page. */
  inject: (script: string) => void;
  /** Handles a fully validated command. */
  dispatch: (message: WebToNativeMessage) => Promise<void>;
  /** Current shell state for the handshake reply. */
  describeShell: () => Promise<ShellDescription> | ShellDescription;
}

interface OutboundDraft {
  type: NativeToWebMessage["type"];
  payload: unknown;
  sessionId?: string;
  revision?: number;
}

export class NativeBridge {
  private queue: NativeToWebMessage[] = [];

  constructor(private readonly deps: NativeBridgeDeps) {}

  /* ------------------------------------------------------------- inbound --- */

  async receive(event: { url?: string; data?: string }): Promise<ReceiveOutcome> {
    const { registry, webOrigin, now } = this.deps;

    // The reporting URL is a necessary check, not a sufficient one: a subframe's
    // message can be reported under the main document's URL. It is the channel
    // nonce that establishes *which document* is speaking.
    const fromProductDocument =
      typeof event.url === "string" &&
      classifyNavigation(event.url, { webOrigin }) === "allow-in-webview";
    if (!fromProductDocument) return { status: "rejected", code: "wrong-origin" };

    const channel = registry.current();
    if (!channel) return { status: "rejected", code: "no-channel" };

    const parsed = parseMobileBridgeMessage(event.data ?? "", {
      expectedNonce: channel.nonce,
      nowMs: now(),
    });
    if (!parsed.ok) return { status: "rejected", code: parsed.error.code };

    // A native-to-web type arriving inbound is not a command, whatever its
    // shape: the page must not be able to forge an event it was meant to receive.
    if (!WEB_TO_NATIVE.has(parsed.message.type)) {
      return { status: "rejected", code: "not-a-command" };
    }
    const command = parsed.message as WebToNativeMessage;

    if (!registry.rememberMessage(channel.nonce, command.messageId)) {
      return { status: "rejected", code: "duplicate-message" };
    }

    if (command.type === "web.hello") {
      await this.handleHello(command);
      return { status: "handled", type: command.type };
    }

    const handshake = registry.handshake();
    if (!handshake) return { status: "rejected", code: "handshake-required" };
    if (command.protocolVersion !== handshake.protocolVersion) {
      return { status: "rejected", code: "protocol-mismatch" };
    }

    await this.deps.dispatch(command);
    return { status: "handled", type: command.type };
  }

  /**
   * Negotiates the version and answers with `native.hello`.
   *
   * When the ranges do not overlap the shell still answers — with a null
   * selection — so the page can tell "this shell is too old" apart from "there
   * is no shell", and ask for a store update rather than silently starting its
   * own navigation engine alongside a native session.
   */
  private async handleHello(command: Extract<WebToNativeMessage, { type: "web.hello" }>) {
    const { registry } = this.deps;
    const channel = registry.current();
    if (!channel) return;

    const selected = negotiateMobileProtocol(
      { min: command.payload.minProtocolVersion, max: command.payload.maxProtocolVersion },
      { min: MOBILE_PROTOCOL_MIN, max: MOBILE_PROTOCOL_MAX },
    );
    if (selected !== null) {
      registry.completeHandshake(channel.nonce, {
        webBuildId: command.payload.webBuildId,
        protocolVersion: selected,
      });
    }

    const shell = await this.deps.describeShell();
    this.emit(
      {
        type: "native.hello",
        payload: {
          ...shell,
          selectedProtocolVersion: selected,
          minProtocolVersion: MOBILE_PROTOCOL_MIN,
          maxProtocolVersion: MOBILE_PROTOCOL_MAX,
        },
      },
      // The handshake reply is the one message that must go out before a
      // handshake exists — including when negotiation failed.
      { immediate: true, protocolVersion: selected ?? MOBILE_PROTOCOL_MAX },
    );
    if (selected !== null) this.flush();
  }

  /* ------------------------------------------------------------ outbound --- */

  /** Sends a native-to-web message, queueing it until the page can receive it. */
  send(
    type: NativeToWebMessage["type"],
    payload: unknown,
    options: { sessionId?: string; revision?: number } = {},
  ): SendOutcome {
    return this.emit({ type, payload, ...options }, {});
  }

  private emit(
    draft: OutboundDraft,
    options: { immediate?: boolean; protocolVersion?: number },
  ): SendOutcome {
    const { registry } = this.deps;
    const channel = registry.current();
    if (!channel) return "dropped";

    const handshake = registry.handshake();
    const candidate = {
      // Before negotiation the envelope carries this build's highest version;
      // nothing is delivered in that state except the handshake reply itself.
      protocolVersion: options.protocolVersion ?? handshake?.protocolVersion ?? MOBILE_PROTOCOL_MAX,
      type: draft.type,
      messageId: this.deps.nextMessageId(),
      channelNonce: channel.nonce,
      ...(draft.sessionId === undefined ? {} : { sessionId: draft.sessionId }),
      ...(draft.revision === undefined ? {} : { revision: draft.revision }),
      sentAtMs: this.deps.now(),
      payload: draft.payload,
    };

    // Validated before encoding, so a malformed native payload is a local error
    // rather than something the page has to defend against.
    const validated = nativeToWebSchema.safeParse(candidate);
    if (!validated.success) return "invalid";

    if (!options.immediate && !handshake) return this.enqueue(validated.data);

    this.deps.inject(buildOutboundScript(validated.data));
    return "sent";
  }

  /**
   * Holds a message for a page that cannot receive it yet.
   *
   * A superseded snapshot is replaced rather than queued behind its successor:
   * delivering a stale position after a reload would show the user where they
   * used to be, which is worse than showing nothing for one more tick. Under
   * pressure the same rule decides what gets dropped — snapshots first, and a
   * queue of nothing but critical messages refuses new work rather than
   * discarding any of it.
   */
  private enqueue(message: NativeToWebMessage): SendOutcome {
    if (message.type === "snapshot.update") {
      this.queue = this.queue.filter((entry) => entry.type !== "snapshot.update");
    }
    if (this.queue.length >= MAX_QUEUED_OUTBOUND) {
      const droppable = this.queue.findIndex((entry) => entry.type === "snapshot.update");
      if (droppable === -1) return "dropped";
      this.queue.splice(droppable, 1);
    }
    this.queue.push(message);
    return "queued";
  }

  /** Delivers everything held while the page was not ready. */
  flush(): number {
    const pending = this.queue;
    this.queue = [];
    for (const message of pending) this.deps.inject(buildOutboundScript(message));
    return pending.length;
  }

  /** Drops queued output, e.g. when the document that would receive it is gone. */
  discardQueue(): void {
    this.queue = [];
  }

  get queuedCount(): number {
    return this.queue.length;
  }
}
