/**
 * Signing in through the system browser.
 *
 * Embedded user agents are not a durable contract for OAuth or WebAuthn — one
 * provider blocks them outright, another breaks them at a version bump, and
 * platform authenticators are simply not available inside a WebView. So the
 * approved operations happen in the real browser, and this is the narrow piece
 * that opens one.
 *
 * The app never receives a session. It receives an opaque callback code, which
 * is useless without the PKCE verifier it kept in memory and never wrote down.
 * That is the whole design: even an app on the device that manages to intercept
 * the custom-scheme callback has nothing it can redeem.
 *
 * Everything here is memory-only and single-attempt. There is no persistence, no
 * retry, and no outbox entry — a half-finished sign-in that survived a restart
 * would be a credential-shaped thing sitting in storage, and the honest answer
 * to an interrupted sign-in is to sign in again.
 */

export type AuthPurpose = "sign-in" | "link-provider" | "add-passkey";

export type SystemAuthStatus = "ok" | "cancelled" | "failed";

export type SystemAuthResult =
  | { status: "ok"; callbackCode: string; state: string; codeVerifier: string }
  | { status: Exclude<SystemAuthStatus, "ok"> };

export interface SystemAuthConfig {
  /** The compiled web origin. Never taken from a message. */
  webOrigin: string;
  /** The compiled custom scheme, without `:`. */
  scheme: string;
}

export interface SystemBrowser {
  /**
   * Opens `url` and resolves with the callback URL the OS routed back, or null
   * when the user dismissed the browser.
   */
  openAuthSessionAsync(url: string, redirectUrl: string): Promise<string | null>;
}

export interface SystemAuthDeps {
  config: SystemAuthConfig;
  browser: SystemBrowser;
  /** 32 bytes from the platform CSPRNG, base64url. */
  randomBytes: (length: number) => string;
}

/** RFC 7636 puts the verifier at 43–128 characters; 32 bytes gives 43. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

/** S256, via the platform's own digest. */
export type Sha256 = (input: string) => Promise<string>;

export class SystemAuthSession {
  /** In-flight attempt state. Cleared on every exit path, including throws. */
  private attempt: { state: string; codeVerifier: string } | null = null;

  constructor(
    private readonly deps: SystemAuthDeps,
    private readonly sha256: Sha256,
  ) {}

  /** The callback the app is willing to be called back on. Compiled, not passed. */
  get redirectUrl(): string {
    return `${this.deps.config.scheme}://auth/callback`;
  }

  /**
   * Runs one system-browser attempt.
   *
   * The URL is constructed here from the compiled origin, so no caller — and no
   * bridge message — can contribute a host, a path, or a redirect.
   */
  async open(purpose: AuthPurpose): Promise<SystemAuthResult> {
    // A second concurrent attempt would leave two verifiers alive and make the
    // returned callback ambiguous.
    if (this.attempt) return { status: "failed" };

    const codeVerifier = this.deps.randomBytes(VERIFIER_BYTES);
    const state = this.deps.randomBytes(STATE_BYTES);
    this.attempt = { state, codeVerifier };

    try {
      const codeChallenge = await this.sha256(codeVerifier);
      const url = new URL("/mobile-auth", this.deps.config.webOrigin);
      url.searchParams.set("purpose", purpose);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");

      const callback = await this.deps.browser.openAuthSessionAsync(
        url.toString(),
        this.redirectUrl,
      );
      if (!callback) return { status: "cancelled" };

      const parsed = this.readCallback(callback, state);
      if (!parsed) return { status: "failed" };
      return { status: "ok", callbackCode: parsed.code, state, codeVerifier };
    } catch {
      return { status: "failed" };
    } finally {
      // Including on the success path: the verifier has been handed to the
      // caller, and a copy left here is a copy that can outlive the attempt.
      this.attempt = null;
    }
  }

  /** Forgets an attempt outright — cancellation, backgrounding, or restart. */
  cancel(): void {
    this.attempt = null;
  }

  get hasAttemptInFlight(): boolean {
    return this.attempt !== null;
  }

  /**
   * Validates the callback URL.
   *
   * Exactly one scheme, exactly one host, exactly one path, and a state that
   * matches the attempt. Anything else came from somewhere this app did not
   * send anybody.
   */
  private readCallback(rawUrl: string, expectedState: string): { code: string } | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol.replace(/:$/, "").toLowerCase() !== this.deps.config.scheme.toLowerCase()) {
      return null;
    }
    if (url.username !== "" || url.password !== "") return null;
    if (url.host.toLowerCase() !== "auth") return null;
    if (url.pathname.replace(/\/+$/, "") !== "/callback") return null;

    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !code) return null;
    // A mismatched state means this callback belongs to a different attempt, or
    // to no attempt of ours at all.
    if (state !== expectedState) return null;
    if (code.length < 16 || code.length > 256 || !/^[A-Za-z0-9_-]+$/.test(code)) return null;

    return { code };
  }
}
