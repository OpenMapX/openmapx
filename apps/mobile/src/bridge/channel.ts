import { encodeBase64Url } from "./base64";

/**
 * Per-document bridge state.
 *
 * `onMessage` tells the shell that *something* in the WebView called
 * `postMessage`; it does not say which document, which frame, or whether the
 * page has reloaded since the last command. The channel supplies what the
 * transport cannot: a nonce minted for exactly one top-level document load, and
 * the handshake and dedupe state scoped to that same load.
 *
 * A reload therefore mints a new nonce and drops everything the previous
 * document accumulated, so a message captured from the old document — or
 * replayed by a frame that outlived it — no longer matches.
 */

/** 256 bits, so a nonce cannot be guessed within the lifetime of a page load. */
export const CHANNEL_NONCE_BYTES = 32;
/** In-memory dedupe ceiling for one document. Oldest entries are evicted first. */
export const MAX_SEEN_MESSAGE_IDS = 2_048;

export type RandomSource = (byteLength: number) => Uint8Array;

/**
 * Cryptographic randomness or nothing.
 *
 * A `Math.random` fallback would be indistinguishable in tests and useless in
 * practice, so a runtime without `getRandomValues` fails loudly instead of
 * quietly minting guessable nonces.
 */
export const defaultRandomSource: RandomSource = (byteLength) => {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error("bridge channel requires crypto.getRandomValues");
  }
  return source.getRandomValues(new Uint8Array(byteLength));
};

export interface ChannelHandshake {
  webBuildId: string;
  protocolVersion: number;
}

export interface BridgeChannel {
  readonly nonce: string;
  readonly createdAtMs: number;
  handshake: ChannelHandshake | null;
  readonly seenMessageIds: Set<string>;
}

export function mintChannelNonce(random: RandomSource = defaultRandomSource): string {
  const bytes = random(CHANNEL_NONCE_BYTES);
  if (bytes.length !== CHANNEL_NONCE_BYTES) {
    throw new Error("bridge channel nonce source returned the wrong length");
  }
  return encodeBase64Url(bytes);
}

export function createBridgeChannel(
  nowMs: number,
  random: RandomSource = defaultRandomSource,
): BridgeChannel {
  return {
    nonce: mintChannelNonce(random),
    createdAtMs: nowMs,
    handshake: null,
    seenMessageIds: new Set(),
  };
}

/**
 * Owns the one live channel.
 *
 * Every check the bridge performs is expressed here as a question about the
 * *current* channel, so there is no path where a stale nonce is accepted merely
 * because the object still exists somewhere.
 */
export class ChannelRegistry {
  private channel: BridgeChannel | null = null;

  constructor(private readonly random: RandomSource = defaultRandomSource) {}

  current(): BridgeChannel | null {
    return this.channel;
  }

  /** Mints a nonce to publish to the *next* document. */
  mintNonce(): string {
    return mintChannelNonce(this.random);
  }

  /**
   * A new top-level document is loading, and will receive `nonce`.
   *
   * The nonce is supplied rather than minted here because it must already be in
   * the document-start script by the time the document exists: the shell
   * publishes one nonce, waits for the load it belongs to, and only then
   * prepares a different one for the load after it.
   *
   * Called from the WebView's main-frame load start, which fires for a real
   * navigation or reload but not for in-document history changes — so a
   * same-origin `pushState` keeps its channel, exactly as intended.
   */
  adoptDocument(nonce: string, nowMs: number): BridgeChannel {
    this.channel = { nonce, createdAtMs: nowMs, handshake: null, seenMessageIds: new Set() };
    return this.channel;
  }

  /** Convenience for callers that do not publish a script, such as tests. */
  beginDocumentLoad(nowMs: number): BridgeChannel {
    return this.adoptDocument(this.mintNonce(), nowMs);
  }

  /** Drops the channel entirely, e.g. after a failed load. */
  invalidate(): void {
    this.channel = null;
  }

  isCurrent(nonce: string): boolean {
    return this.channel !== null && this.channel.nonce === nonce;
  }

  handshake(): ChannelHandshake | null {
    return this.channel?.handshake ?? null;
  }

  /** Binds the negotiated version to this document. Never overwrites an existing one. */
  completeHandshake(nonce: string, handshake: ChannelHandshake): boolean {
    if (!this.channel || this.channel.nonce !== nonce) return false;
    if (this.channel.handshake) return false;
    this.channel.handshake = handshake;
    return true;
  }

  /**
   * Records a message ID, returning false when it has already been seen.
   *
   * This is the cheap in-document guard. Mutating commands additionally consult
   * the durable command table, because a process restart empties this set while
   * the page's retry logic does not.
   */
  rememberMessage(nonce: string, messageId: string): boolean {
    if (!this.channel || this.channel.nonce !== nonce) return false;
    const seen = this.channel.seenMessageIds;
    if (seen.has(messageId)) return false;
    if (seen.size >= MAX_SEEN_MESSAGE_IDS) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    seen.add(messageId);
    return true;
  }
}
