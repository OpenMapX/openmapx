/**
 * Whether this page is running inside the installed OpenMapX shell.
 *
 * Deliberately synchronous and answerable on the very first render. Several
 * decisions depend on it that cannot wait for a handshake: whether to offer
 * microphone input and whether the browser navigation engine may start at all.
 *
 * So the descriptor the shell injects before any page script is the authority
 * here, not the handshake. A page that sees the descriptor is in the shell, even
 * if the bridge never answers.
 */

export const CHANNEL_GLOBAL = "__OPENMAPX_MOBILE_CHANNEL__";

export interface ShellDescriptor {
  nonce: string;
}

export interface ShellTransport {
  postMessage(message: string): void;
}

/**
 * Reads the injected descriptor.
 *
 * Anything that is not an object with a non-empty string nonce is treated as
 * absent. A partially-formed descriptor is more likely tampering or a bug than a
 * shell, and neither deserves the trust the real one gets.
 */
export function readShellDescriptor(scope: unknown = globalThis): ShellDescriptor | null {
  const holder = scope as Record<string, unknown> | null | undefined;
  const value = holder?.[CHANNEL_GLOBAL];
  if (!value || typeof value !== "object") return null;
  const nonce = (value as { nonce?: unknown }).nonce;
  if (typeof nonce !== "string" || nonce.length === 0) return null;
  return { nonce };
}

export function readShellTransport(scope: unknown = globalThis): ShellTransport | null {
  const holder = scope as Record<string, unknown> | null | undefined;
  const transport = holder?.ReactNativeWebView as { postMessage?: unknown } | undefined;
  if (!transport || typeof transport.postMessage !== "function") return null;
  return transport as ShellTransport;
}

/**
 * The one question every feature guard asks.
 *
 * True from the first render inside the shell, regardless of whether the bridge
 * has negotiated, failed, or turned out to be incompatible. "We are in the
 * app" and "the app can run navigation" are different questions, and conflating
 * them is how unreviewed code ends up executing during negotiation.
 */
export function isInstalledShell(scope: unknown = globalThis): boolean {
  return readShellDescriptor(scope) !== null;
}

/**
 * Capabilities the installed shell removes outright.
 *
 * Each of these is either something native owns exclusively, or something the
 * app store review model does not permit an installed binary to do. None of them
 * depend on the protocol version, so none of them wait for a handshake.
 */
export interface ShellFeatureBoundary {
  /** Browser microphone access, including voice search. */
  microphone: boolean;
  /** The browser's own geolocation watch. */
  browserGeolocationWatch: boolean;
  /** Browser speech synthesis for navigation cues. */
  browserSpeech: boolean;
  /** Web notifications for navigation events. */
  browserNotifications: boolean;
  /** The browser's IndexedDB navigation-session persistence. */
  browserSessionPersistence: boolean;
  /** The browser's wake lock. */
  browserWakeLock: boolean;
}

const BROWSER_BOUNDARY: ShellFeatureBoundary = {
  microphone: true,
  browserGeolocationWatch: true,
  browserSpeech: true,
  browserNotifications: true,
  browserSessionPersistence: true,
  browserWakeLock: true,
};

const SHELL_BOUNDARY: ShellFeatureBoundary = {
  // The shell declares no microphone use, and a store build that asks for one it
  // never declared is a rejection.
  microphone: false,
  // Native owns the one location stream. A second producer would race it.
  browserGeolocationWatch: false,
  browserSpeech: false,
  browserNotifications: false,
  // Two durable session owners would disagree the first time one crashed.
  browserSessionPersistence: false,
  browserWakeLock: false,
};

export function shellFeatureBoundary(scope: unknown = globalThis): ShellFeatureBoundary {
  return isInstalledShell(scope) ? SHELL_BOUNDARY : BROWSER_BOUNDARY;
}
