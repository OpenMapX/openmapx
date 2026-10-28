import { createPublicKey } from "node:crypto";
import type { IntegrationContext, RouteHandler } from "@openmapx/integration-framework";

const SIGNER_URL = "https://signer.mangrove.reviews";
const ACCOUNT_URL = "https://mangrove.reviews/account";
const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 10_000;

type Registration = { clientId: string; redirectUri: string };
export type MangroveSignerConfig =
  | { configured: false }
  | ({ configured: true; signerUrl: string; accountUrl: string } & Registration);
export interface MangroveSignerAccount {
  reviewerId: string;
  publicPem: string;
  did?: string;
  accountName?: string;
  provider?: string;
}
export interface MangroveSignerSignature {
  jwt: string;
  publicPem: string;
  reviewerId: string;
  did?: string;
}

class SignerFailure extends Error {
  constructor(readonly status: number) {
    super("Mangrove signer request failed");
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);

/** Invalid operator settings disable signing without preventing integration startup. */
function registration(config: Record<string, unknown>): Registration | undefined {
  const clientId = config.signerClientId;
  const redirectUri = config.signerRedirectUri;
  if (!text(clientId, 256) || /\s/.test(clientId) || !text(redirectUri, 2048)) return;
  try {
    const url = new URL(redirectUri);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      !url.hostname ||
      url.hostname.includes("*") ||
      url.username ||
      url.password ||
      url.pathname !== "/auth/mangrove" ||
      url.search ||
      url.hash ||
      redirectUri !== redirectUri.trim()
    )
      return;
    return { clientId, redirectUri };
  } catch {
    return;
  }
}

/** Race uncooperative policy/runtime implementations too; late work cannot publish. */
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new SignerFailure(503));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return operation();
        })
        .then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function publicIdentity(
  body: unknown,
): Pick<MangroveSignerAccount, "reviewerId" | "publicPem" | "did"> {
  if (
    !record(body) ||
    !text(body.reviewer_id, 256) ||
    typeof body.public_key !== "string" ||
    body.public_key.length > 2048
  )
    throw new SignerFailure(502);
  // createPublicKey also accepts private keys: restrict the entire PEM envelope first.
  if (
    !/^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(
      body.public_key,
    )
  )
    throw new SignerFailure(502);
  try {
    const der = body.public_key
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replace(/\s/g, "");
    const bytes = Buffer.from(der, "base64");
    const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
    if (
      bytes.toString("base64") !== der ||
      !key.export({ type: "spki", format: "der" }).equals(bytes)
    )
      throw new SignerFailure(502);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new SignerFailure(502);
  } catch {
    throw new SignerFailure(502);
  }
  const identity: Pick<MangroveSignerAccount, "reviewerId" | "publicPem" | "did"> = {
    reviewerId: body.reviewer_id,
    publicPem: body.public_key,
  };
  if (body.did != null) {
    if (!text(body.did, 2048) || !/^did:[a-z0-9]+:\S+$/.test(body.did))
      throw new SignerFailure(502);
    identity.did = body.did;
  }
  return identity;
}

function account(body: unknown): MangroveSignerAccount {
  const result: MangroveSignerAccount = publicIdentity(body);
  if (!record(body)) throw new SignerFailure(502);
  if (body.account_name != null) {
    if (!text(body.account_name, 256)) throw new SignerFailure(502);
    result.accountName = body.account_name;
  }
  if (body.provider != null) {
    if (!text(body.provider, 64)) throw new SignerFailure(502);
    result.provider = body.provider;
  }
  return result;
}

function signature(body: unknown): MangroveSignerSignature {
  const identity = publicIdentity(body);
  if (
    !record(body) ||
    !text(body.jwt, MAX_BYTES) ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.jwt)
  )
    throw new SignerFailure(502);
  // Full JWT/key/request-content verification belongs to the submitting client.
  return { jwt: body.jwt, ...identity };
}

function reviewSnapshot(value: unknown): Record<string, unknown> {
  if (
    !record(value) ||
    !text(value.sub, 8192) ||
    Object.keys(value).some(
      (key) => !["sub", "rating", "opinion", "images", "action", "metadata"].includes(key),
    )
  )
    throw new SignerFailure(400);
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > 64 * 1024) throw new SignerFailure(400);
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    throw new SignerFailure(400);
  }
}

export function registerSignerRoutes(ctx: IntegrationContext): void {
  const configured = registration(ctx.config);
  const generation = new AbortController();
  ctx.onShutdown(async () => {
    generation.abort();
  });
  const signalFor = (request?: AbortSignal) =>
    AbortSignal.any([
      generation.signal,
      AbortSignal.timeout(TIMEOUT_MS),
      ...(request ? [request] : []),
    ]);
  async function assertAllowed(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const sources = await bounded(
      async () => (ctx.getDisallowedSourceIds ? ctx.getDisallowedSourceIds() : new Set<string>()),
      signal,
    );
    signal.throwIfAborted();
    if (sources.has("mangrove-signer") || sources.has(ctx.id)) throw new SignerFailure(503);
    const integrations = await bounded(
      async () =>
        ctx.getDisallowedIntegrationIds ? ctx.getDisallowedIntegrationIds() : new Set<string>(),
      signal,
    );
    signal.throwIfAborted();
    if (integrations.has(ctx.id)) throw new SignerFailure(503);
  }
  const config: RouteHandler = async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!req.userId) {
      reply.status(401).send({ error: "Authentication required" });
      return;
    }
    const signal = signalFor(req.signal);
    try {
      await assertAllowed(signal);
      signal.throwIfAborted();
      const result: MangroveSignerConfig =
        configured && typeof ctx.upstreamRuntime?.admitSharedRequest === "function"
          ? { configured: true, ...configured, signerUrl: SIGNER_URL, accountUrl: ACCOUNT_URL }
          : { configured: false };
      reply.send(result);
    } catch {
      reply.send({ configured: false });
    }
  };
  function relay(path: "/account" | "/reviews/sign" | "/auth/revoke"): RouteHandler {
    return async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const signal = signalFor(req.signal);
      try {
        if (!req.userId) throw new SignerFailure(401);
        const body = req.body;
        if (!record(body)) throw new SignerFailure(400);
        if (body.expectedUserId !== undefined) {
          if (!text(body.expectedUserId, 256)) throw new SignerFailure(400);
          if (body.expectedUserId !== req.userId) throw new SignerFailure(401);
        }
        if (!text(body.sessionToken, 8192) || /\s/.test(body.sessionToken))
          throw new SignerFailure(400);
        const upstreamBody = {
          session_token: body.sessionToken,
          ...(path === "/reviews/sign" ? { review: reviewSnapshot(body.review) } : {}),
        };
        await assertAllowed(signal);
        signal.throwIfAborted();
        const runtime = ctx.upstreamRuntime;
        if (!configured || typeof runtime?.admitSharedRequest !== "function")
          throw new SignerFailure(503);
        const admit = runtime.admitSharedRequest.bind(runtime);
        const decision = await bounded(
          () =>
            admit({
              scope: "mangrove-signer",
              key: `${SIGNER_URL}|${configured.clientId}`,
              signal,
            }),
          signal,
        );
        signal.throwIfAborted();
        if (decision.allowed !== true)
          throw new SignerFailure(
            decision.allowed === false && ["spacing", "quota", "cooldown"].includes(decision.reason)
              ? 429
              : 503,
          );
        await assertAllowed(signal);
        signal.throwIfAborted();
        // The host JSON response method requires JSON even for errors/204. Text transport
        // preserves status while discarding error bodies; successful JSON remains bounded.
        const response = await bounded(
          () =>
            ctx.http.postText(`${SIGNER_URL}${path}`, JSON.stringify(upstreamBody), {
              headers: { Accept: "application/json", "Content-Type": "application/json" },
              signal,
              timeoutMs: TIMEOUT_MS,
              maxBytes: MAX_BYTES,
              contentTypes: ["application/json"],
              redirect: "error",
              discardErrorBody: true,
              successStatuses: [path === "/auth/revoke" ? 204 : 200],
              ...(path === "/auth/revoke" ? { fallbackContentType: "application/json" } : {}),
            }),
          signal,
        );
        signal.throwIfAborted();
        await assertAllowed(signal);
        signal.throwIfAborted();
        if (response.status !== (path === "/auth/revoke" ? 204 : 200))
          throw new SignerFailure(
            [400, 401, 403, 429].includes(response.status) ? response.status : 502,
          );
        const result =
          path === "/account"
            ? account(JSON.parse(response.body))
            : path === "/reviews/sign"
              ? signature(JSON.parse(response.body))
              : { ok: true };
        signal.throwIfAborted();
        reply.send(result);
      } catch (error) {
        const status = signal.aborted ? 503 : error instanceof SignerFailure ? error.status : 503;
        reply.status(status).send({
          error:
            status === 401
              ? "Mangrove signer authentication required"
              : status === 429
                ? "Mangrove signer rate limit reached"
                : status === 400
                  ? "Invalid Mangrove signer request"
                  : status === 403
                    ? "Mangrove signer request denied"
                    : "Mangrove signer unavailable",
        });
      }
    };
  }
  ctx.registerRoute("GET", "/signer/config", config, {
    requireAuth: true,
    rateLimitTier: "expensive",
  });
  ctx.registerRoute("POST", "/signer/account", relay("/account"), {
    requireAuth: true,
    rateLimitTier: "expensive",
  });
  ctx.registerRoute("POST", "/signer/sign", relay("/reviews/sign"), {
    requireAuth: true,
    rateLimitTier: "expensive",
  });
  ctx.registerRoute("POST", "/signer/revoke", relay("/auth/revoke"), {
    requireAuth: true,
    rateLimitTier: "expensive",
  });
}
