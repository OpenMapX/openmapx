import type { MangroveReviewPayload } from "@openmapx/mangrove-client";

export type SignerConfig =
  | { configured: false }
  | {
      configured: true;
      clientId: string;
      redirectUri: string;
      signerUrl: string;
      accountUrl: string;
    };
export interface SignerAccount {
  reviewerId: string;
  publicPem: string;
  did?: string;
  accountName?: string;
  provider?: string;
}
export interface SignerTransport {
  getConfig(options?: { signal?: AbortSignal }): Promise<SignerConfig>;
  getAccount(token: string, options?: { signal?: AbortSignal }): Promise<SignerAccount>;
  signReview(
    token: string,
    review: MangroveReviewPayload,
    options?: { signal?: AbortSignal },
  ): Promise<{ jwt: string; publicPem: string; reviewerId: string; did?: string }>;
  revokeSession(token: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface SignerSnapshot {
  mode: "signer" | "local";
  status: "disconnected" | "restoring" | "connected" | "expired" | "error";
  account: SignerAccount | null;
  config: SignerConfig | null;
}
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface Options {
  owner: string;
  origin: string;
  storage: StorageLike;
  transport: SignerTransport;
  now?: () => number;
}
const SESSION = "openmapx.mangrove.signer";
const PENDING = "openmapx.mangrove.login";
const MODE = "openmapx.mangrove.mode";
const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
export class MangroveSignerError extends Error {
  constructor(readonly status = 0) {
    super(status === 401 ? "Mangrove login expired" : "Mangrove connection unavailable");
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function statusOf(error: unknown): number {
  return object(error) && typeof error.status === "number" ? error.status : 0;
}
function registration(config: Extract<SignerConfig, { configured: true }>): string {
  return JSON.stringify([config.signerUrl, config.clientId, config.redirectUri]);
}

/** Owns bearer material outside query/mutation state. Disposed work can never publish. */
export function createMangroveSigner({
  owner,
  origin,
  storage,
  transport,
  now = Date.now,
}: Options) {
  let snapshot: SignerSnapshot = {
    mode: "signer",
    status: "disconnected",
    account: null,
    config: null,
  };
  let token: string | null = null;
  let connectedRegistration: string | null = null;
  let generation = 0;
  let active = false;
  let abort = new AbortController();
  const listeners = new Set<() => void>();
  const publish = (next: Partial<SignerSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const read = (key: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
      return object(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const capture = () => {
    if (!active) throw new MangroveSignerError();
    return { generation, signal: abort.signal };
  };
  const assert = (op: ReturnType<typeof capture>) => {
    if (!active || op.generation !== generation || op.signal.aborted)
      throw new MangroveSignerError();
  };
  const invalidate = () => {
    generation++;
    abort.abort();
    abort = new AbortController();
    token = null;
    connectedRegistration = null;
  };
  const forget = () => {
    storage.removeItem(SESSION);
    storage.removeItem(PENDING);
  };
  async function configFor(op: ReturnType<typeof capture>) {
    let config: SignerConfig;
    try {
      config = await transport.getConfig({ signal: op.signal });
    } catch {
      assert(op);
      throw new MangroveSignerError();
    }
    assert(op);
    if (config.configured) {
      const redirect = new URL(config.redirectUri);
      if (
        config.signerUrl !== "https://signer.mangrove.reviews" ||
        redirect.origin !== origin ||
        redirect.pathname !== "/auth/mangrove" ||
        redirect.search ||
        redirect.hash ||
        redirect.username ||
        redirect.password
      )
        throw new MangroveSignerError();
    }
    publish({ config });
    return config;
  }
  function handleFailure(error: unknown, op: ReturnType<typeof capture>): never {
    assert(op);
    const status = statusOf(error);
    if (status === 401) {
      invalidate();
      forget();
      publish({ status: "expired", account: null });
    } else publish({ status: "error" });
    throw new MangroveSignerError(status);
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate() {
      if (!active) {
        active = true;
        abort = new AbortController();
        generation++;
      }
    },
    dispose() {
      active = false;
      invalidate();
      publish({ status: "disconnected", account: null });
    },
    async restore() {
      const op = capture();
      const mode = read(MODE);
      if (mode?.owner === owner && mode.mode === "local") publish({ mode: "local" });
      const saved = read(SESSION);
      if (saved && saved.owner !== owner) forget();
      try {
        const config = await configFor(op);
        if (snapshot.mode === "local" || !saved || saved.owner !== owner) return;
        if (!config.configured) {
          publish({ status: "error" });
          return;
        }
        if (
          saved.registration !== registration(config) ||
          typeof saved.token !== "string" ||
          typeof saved.createdAt !== "number" ||
          now() - saved.createdAt >= DAY ||
          saved.createdAt > now()
        ) {
          forget();
          return;
        }
        publish({ status: "restoring" });
        const account = await transport.getAccount(saved.token, { signal: op.signal });
        assert(op);
        token = saved.token;
        connectedRegistration = registration(config);
        publish({ mode: "signer", status: "connected", account });
      } catch (error) {
        handleFailure(error, op);
      }
    },
    async beginLogin(provider: "osm" | "bluesky" | "passkey", returnTo: string, handle?: string) {
      const op = capture();
      if (
        !returnTo.startsWith("/") ||
        returnTo.startsWith("//") ||
        returnTo.includes("\\") ||
        new URL(returnTo, origin).origin !== origin
      )
        throw new MangroveSignerError();
      const config = await configFor(op);
      if (!config.configured) throw new MangroveSignerError();
      invalidate();
      forget();
      publish({ mode: "signer", status: "disconnected", account: null });
      storage.removeItem(MODE);
      const state = crypto.randomUUID();
      storage.setItem(
        PENDING,
        JSON.stringify({
          owner,
          registration: registration(config),
          state,
          createdAt: now(),
          returnTo,
        }),
      );
      const url = new URL("/auth/login", config.signerUrl);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("provider", provider);
      url.searchParams.set("state", state);
      if (provider === "bluesky" && handle?.trim()) url.searchParams.set("handle", handle.trim());
      return url.href;
    },
    async acceptCallback(url: string) {
      const op = capture();
      const callback = new URL(url);
      const params = new URLSearchParams(callback.hash.slice(1));
      for (const key of [
        "state",
        "session_token",
        "reviewer_id",
        "did",
        "error",
        "error_description",
      ])
        if (params.getAll(key).length > 1) throw new MangroveSignerError();
      const config = await configFor(op);
      assert(op);
      const pending = read(PENDING);
      storage.removeItem(PENDING);
      if (
        !config.configured ||
        callback.origin !== origin ||
        callback.pathname !== "/auth/mangrove" ||
        !pending ||
        pending.owner !== owner ||
        pending.registration !== registration(config) ||
        typeof pending.state !== "string" ||
        params.get("state") !== pending.state ||
        typeof pending.createdAt !== "number" ||
        now() - pending.createdAt > TEN_MINUTES ||
        pending.createdAt > now() ||
        params.has("error")
      )
        throw new MangroveSignerError();
      const received = params.get("session_token");
      if (!received || !/^[A-Za-z0-9_-]{16,512}$/.test(received)) throw new MangroveSignerError();
      publish({ mode: "signer", status: "restoring" });
      try {
        const account = await transport.getAccount(received, { signal: op.signal });
        assert(op);
        token = received;
        connectedRegistration = registration(config);
        storage.setItem(
          SESSION,
          JSON.stringify({ owner, token, registration: connectedRegistration, createdAt: now() }),
        );
        storage.removeItem(MODE);
        publish({ mode: "signer", status: "connected", account });
        return typeof pending.returnTo === "string" &&
          pending.returnTo.startsWith("/") &&
          !pending.returnTo.startsWith("//") &&
          !pending.returnTo.includes("\\")
          ? pending.returnTo
          : "/";
      } catch (error) {
        return handleFailure(error, op);
      }
    },
    async sign(review: MangroveReviewPayload) {
      const op = capture();
      const currentToken = token;
      const account = snapshot.account;
      if (snapshot.mode !== "signer" || !currentToken || !account)
        throw new MangroveSignerError(401);
      try {
        const config = await configFor(op);
        if (!config.configured) throw new MangroveSignerError(503);
        if (registration(config) !== connectedRegistration) throw new MangroveSignerError(401);
        const result = await transport.signReview(currentToken, review, { signal: op.signal });
        assert(op);
        if (result.publicPem !== account.publicPem || result.reviewerId !== account.reviewerId)
          throw new MangroveSignerError();
        publish({ status: "connected" });
        return { ...result, signal: op.signal, assertCurrent: () => assert(op) };
      } catch (error) {
        return handleFailure(error, op);
      }
    },
    async disconnect() {
      const old = token;
      invalidate();
      forget();
      storage.removeItem(MODE);
      publish({ mode: "signer", status: "disconnected", account: null });
      if (old) {
        try {
          await transport.revokeSession(old);
        } catch {
          /* Local removal does not depend on the signer being reachable. */
        }
      }
    },
    selectLocal() {
      const old = token;
      invalidate();
      forget();
      storage.setItem(MODE, JSON.stringify({ owner, mode: "local" }));
      publish({ mode: "local", status: "disconnected", account: null });
      if (old) void transport.revokeSession(old).catch(() => undefined);
    },
  };
}
export type MangroveSignerController = ReturnType<typeof createMangroveSigner>;

/** Remove tab credentials when the host authentication session changes. */
export function clearMangroveSignerStorage(storage: StorageLike): void {
  for (const key of [SESSION, PENDING, MODE, "openmapx.mangrove.draft"]) storage.removeItem(key);
}
