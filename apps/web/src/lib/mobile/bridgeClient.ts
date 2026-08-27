import {
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  type NativeToWebMessage,
  nativeToWebSchema,
  type WebToNativeMessage,
  webToNativeSchema,
} from "@openmapx/core/navigation";
import {
  readShellDescriptor,
  readShellTransport,
  type ShellTransport,
} from "./mobileShellEnvironment";

/**
 * The page's side of the bridge.
 *
 * Its job is narrow: negotiate a version once per document, send schema-valid
 * commands, and match replies to the commands that asked for them. Everything
 * about how a session behaves lives natively; this only has to be honest about
 * whether a command arrived and whether an answer came back.
 *
 * The failure it exists to prevent is a promise that never settles. A page
 * waiting forever on a reply that the shell dropped — because the document
 * reloaded, because the shell is incompatible, because the request timed out —
 * shows a spinner the user cannot escape. So every pending request has a
 * deadline, a reload cancels all of them, and the queue is bounded.
 */

/** How long a preparation-class command may take before it is abandoned. */
export const PREPARE_TIMEOUT_MS = 15_000;
/** How long a read-only command may take. */
export const READ_TIMEOUT_MS = 5_000;
/** More outstanding requests than this means something is looping. */
export const MAX_PENDING = 256;

export type BridgeFailure =
  | "no-transport"
  | "not-negotiated"
  | "incompatible"
  | "timeout"
  | "channel-reset"
  | "too-many-pending"
  | "invalid-command"
  | "invalid-response";

export class BridgeError extends Error {
  readonly code: BridgeFailure;

  constructor(code: BridgeFailure) {
    super(`bridge request failed: ${code}`);
    this.name = "BridgeError";
    this.code = code;
  }
}

export interface HandshakeResult {
  selectedProtocolVersion: number | null;
  shellVersion: string;
  platform: "ios" | "android";
  capabilities: {
    groundNavigation: boolean;
    transitNavigation: boolean;
    backgroundLocation: boolean;
    localNotifications: boolean;
    speech: boolean;
  };
  permission: string;
  activeSession: { sessionId: string; revision: number; kind: "ground" | "transit" } | null;
}

export interface BridgeClientOptions {
  webBuildId: string;
  scope?: unknown;
  now?: () => number;
  /** Injected so tests drive deadlines without waiting. */
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

type Pending = {
  resolve: (message: NativeToWebMessage) => void;
  reject: (error: BridgeError) => void;
  timer: unknown;
  requestType: WebToNativeMessage["type"];
};

type RequestOptions = {
  timeoutMs?: number;
  sessionId?: string;
  revision?: number;
  requireHandshake?: boolean;
};

const EXPECTED_REPLY: Partial<Record<WebToNativeMessage["type"], NativeToWebMessage["type"]>> = {
  "web.hello": "native.hello",
  "session.prepare": "session.prepared",
  "session.start": "session.started",
  "session.replace": "session.replaced",
  "settings.update": "snapshot.update",
  "snapshot.request": "snapshot.update",
  "session.stop": "session.stopped",
  "session.complete": "session.stopped",
  "location.request": "location.result",
  "settings.open": "settings.result",
  "auth.open": "auth.result",
};

/**
 * Correlates one document's conversation with the shell.
 *
 * Bound to the nonce the shell injected for *this* document. A reload produces a
 * new nonce and therefore a new client; messages from the old one are not
 * replayed, they are abandoned with a reason.
 */
export class BridgeClient {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: NativeToWebMessage) => void>();
  private handshake: HandshakeResult | null = null;
  private nonce: string | null = null;
  private transport: ShellTransport | null = null;
  private closed = false;
  private messageCounter = 0;
  private detach: (() => void) | null = null;

  constructor(private readonly options: BridgeClientOptions) {}

  get isAvailable(): boolean {
    return this.nonce !== null && this.transport !== null;
  }

  get negotiated(): HandshakeResult | null {
    return this.handshake;
  }

  /**
   * Binds to the injected descriptor and starts listening.
   *
   * Returns false when there is no shell, or a shell whose transport is missing
   * — which is a broken shell rather than a browser, and the caller must not
   * treat it as one.
   */
  attach(): boolean {
    const scope = this.options.scope ?? globalThis;
    const descriptor = readShellDescriptor(scope);
    if (!descriptor) return false;
    this.nonce = descriptor.nonce;
    this.transport = readShellTransport(scope);
    if (!this.transport) return false;

    const target = scope as {
      addEventListener?: (type: string, handler: (event: Event) => void) => void;
      removeEventListener?: (type: string, handler: (event: Event) => void) => void;
    };
    const handler = (event: Event) => {
      this.receive((event as CustomEvent).detail);
    };
    target.addEventListener?.("openmapx:native", handler);
    this.detach = () => target.removeEventListener?.("openmapx:native", handler);
    return true;
  }

  /** Abandons every pending request. Called when the document goes away. */
  close(reason: BridgeFailure = "channel-reset"): void {
    this.closed = true;
    for (const [, entry] of this.pending) {
      this.options.clearTimeout?.(entry.timer);
      entry.reject(new BridgeError(reason));
    }
    this.pending.clear();
    this.listeners.clear();
    this.detach?.();
    this.detach = null;
  }

  /** Subscribes to native state/event messages, including requested snapshots. */
  subscribe(listener: (message: NativeToWebMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Negotiates a protocol version.
   *
   * A shell that answers with no overlap is not an error to retry; it is an old
   * binary, and the page has to say so rather than keep trying.
   */
  async hello(): Promise<HandshakeResult> {
    const reply = await this.request(
      "web.hello",
      {
        webBuildId: this.options.webBuildId,
        minProtocolVersion: MOBILE_PROTOCOL_MIN,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
      { timeoutMs: PREPARE_TIMEOUT_MS, requireHandshake: false },
    );
    if (reply.type !== "native.hello") throw new BridgeError("invalid-response");

    const hello = reply.payload;
    if (
      reply.protocolVersion !== MOBILE_PROTOCOL_MAX ||
      (hello.selectedProtocolVersion !== null &&
        (hello.selectedProtocolVersion !== MOBILE_PROTOCOL_MAX ||
          hello.selectedProtocolVersion < hello.minProtocolVersion ||
          hello.selectedProtocolVersion > hello.maxProtocolVersion))
    ) {
      throw new BridgeError("invalid-response");
    }

    this.handshake = hello as HandshakeResult;
    return this.handshake;
  }

  /**
   * Sends one command and waits for the reply that names it.
   *
   * Correlation is by message id rather than by arrival order, because the shell
   * may answer a snapshot request while a slower prepare is still running.
   */
  request(
    type: WebToNativeMessage["type"],
    payload: unknown,
    options: RequestOptions = {},
  ): Promise<NativeToWebMessage> {
    if (this.closed) return Promise.reject(new BridgeError("channel-reset"));
    if (!this.transport || !this.nonce) return Promise.reject(new BridgeError("no-transport"));
    if (options.requireHandshake !== false) {
      if (!this.handshake) return Promise.reject(new BridgeError("not-negotiated"));
      if (this.handshake.selectedProtocolVersion === null) {
        return Promise.reject(new BridgeError("incompatible"));
      }
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(new BridgeError("too-many-pending"));
    }
    this.messageCounter += 1;
    const messageId = `w${this.messageCounter}-${(this.options.now?.() ?? Date.now()).toString(36)}`;
    const envelope = {
      protocolVersion: this.handshake?.selectedProtocolVersion ?? MOBILE_PROTOCOL_MAX,
      type,
      messageId,
      channelNonce: this.nonce,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      sentAtMs: this.options.now?.() ?? Date.now(),
      payload,
    };

    // Validated before sending, so a malformed command is a local error rather
    // than something the shell has to defend against.
    const validated = webToNativeSchema.safeParse(envelope);
    if (!validated.success) return Promise.reject(new BridgeError("invalid-command"));

    return new Promise<NativeToWebMessage>((resolve, reject) => {
      const timer = this.options.setTimeout?.(() => {
        this.pending.delete(messageId);
        reject(new BridgeError("timeout"));
      }, options.timeoutMs ?? READ_TIMEOUT_MS);

      this.pending.set(messageId, { resolve, reject, timer, requestType: type });
      try {
        this.transport?.postMessage(JSON.stringify(validated.data));
      } catch {
        this.pending.delete(messageId);
        this.options.clearTimeout?.(timer);
        reject(new BridgeError("no-transport"));
      }
    });
  }

  /** Sends a command whose protocol contract intentionally has no direct reply. */
  send(type: WebToNativeMessage["type"], payload: unknown, options: RequestOptions = {}): void {
    if (this.closed) throw new BridgeError("channel-reset");
    if (!this.transport || !this.nonce) throw new BridgeError("no-transport");
    if (options.requireHandshake !== false) {
      if (!this.handshake) throw new BridgeError("not-negotiated");
      if (this.handshake.selectedProtocolVersion === null) throw new BridgeError("incompatible");
    }
    const version = this.handshake?.selectedProtocolVersion ?? MOBILE_PROTOCOL_MAX;

    this.messageCounter += 1;
    const envelope = {
      protocolVersion: version,
      type,
      messageId: `w${this.messageCounter}-${(this.options.now?.() ?? Date.now()).toString(36)}`,
      channelNonce: this.nonce,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      sentAtMs: this.options.now?.() ?? Date.now(),
      payload,
    };
    const validated = webToNativeSchema.safeParse(envelope);
    if (!validated.success) throw new BridgeError("invalid-command");
    try {
      this.transport.postMessage(JSON.stringify(validated.data));
    } catch {
      throw new BridgeError("no-transport");
    }
  }

  /**
   * Handles one inbound message.
   *
   * A message that does not parse is dropped rather than surfaced: the page
   * cannot act on something it does not understand, and a reply that fails its
   * own schema is not evidence about anything.
   */
  private receive(detail: unknown): void {
    const parsed = nativeToWebSchema.safeParse(detail);
    if (!parsed.success) return;
    const message = parsed.data;

    // Wrong document. The shell rotates the nonce per load, so this is a message
    // for a page that no longer exists.
    if (this.nonce && message.channelNonce !== this.nonce) return;

    if (message.type !== "native.hello") {
      const selected = this.handshake?.selectedProtocolVersion;
      if (selected === null || selected === undefined || message.protocolVersion !== selected)
        return;
    }

    const forMessageId = (message.payload as { forMessageId?: string }).forMessageId;
    const key = forMessageId ?? null;
    const entry = key ? this.pending.get(key) : undefined;
    if (entry && key) {
      this.pending.delete(key);
      this.options.clearTimeout?.(entry.timer);
      const expectedType = EXPECTED_REPLY[entry.requestType];
      if (message.type !== "native.error" && expectedType !== message.type) {
        entry.reject(new BridgeError("invalid-response"));
        return;
      }
      entry.resolve(message);
      // Snapshot replies have two consumers: the requesting command needs its
      // promise settled, while the runtime subscriber owns the native read
      // model and must apply the snapshot. Correlation must not turn that state
      // update into a request-private message.
      if (message.type === "snapshot.update") {
        for (const listener of this.listeners) listener(message);
      }
      return;
    }

    for (const listener of this.listeners) listener(message);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
